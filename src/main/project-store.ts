/**
 * ② 状態ストアの永続化部分: projects.json / config.json（design.md 9 章 / REQ-01, REQ-06, REQ-13）。
 * 書き込みはすべて一時ファイル → rename のアトミック方式（NFR-03 と同方針）。
 */
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import type { AppConfig, ClickTarget, Project, ThemeSetting, WindowBounds } from "../shared/types";
import { DEFAULT_PORT } from "./constants";
import { writeFileAtomic } from "./hooks-manager";
import type { LoggerLike } from "./logger";
import { nullLogger } from "./logger";
import { normalizePath } from "./state-store";
import { parseWindowBounds } from "./window-bounds";

export interface AddProjectResult {
  ok: boolean;
  project?: Project;
  error?: string;
}

/** 表示名の上限文字数（260903_2）。タイル幅（128px〜）で省略が過剰にならない程度 */
export const PROJECT_NAME_MAX = 40;

export interface RenameResult {
  ok: boolean;
  /** 確定した表示名（空入力時はフォルダ名に戻る） */
  name?: string;
  error?: string;
}

/**
 * 登録対象ディレクトリの検証（design.md 3.2(a) パス検証）。
 * 実在ディレクトリであること・重複登録でないことを確認する。
 * ProjectStore.addProject と main の登録フロー（hooks マージ前の事前検証）で共用し、
 * 検証ロジックの二重実装を防ぐ。
 */
export function validateProjectDir(
  dirPath: string,
  projects: readonly Project[]
): { ok: true } | { ok: false; error: string } {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(dirPath);
  } catch {
    return { ok: false, error: `パスが存在しません: ${dirPath}` };
  }
  if (!stat.isDirectory()) {
    return { ok: false, error: `フォルダのみ登録できます: ${dirPath}` };
  }
  const norm = normalizePath(dirPath);
  if (projects.some((p) => normalizePath(p.path) === norm)) {
    return { ok: false, error: `登録済みです: ${path.basename(dirPath)}` };
  }
  return { ok: true };
}

const CLICK_TARGETS: readonly ClickTarget[] = ["cursor", "orca", "terminal"];

export function isClickTarget(value: unknown): value is ClickTarget {
  return typeof value === "string" && (CLICK_TARGETS as readonly string[]).includes(value);
}

function defaultConfig(): AppConfig {
  return {
    version: 1,
    port: DEFAULT_PORT,
    theme: "auto",
    alwaysOnTopDefault: false,
    notifySound: { enabled: false }, // REQ-12 予約キー。MVP では常に false
    customStatuses: ["作業中", "レビュー待ち", "保留"], // 手動ステータスの初期選択肢（260727_1）
    showUnlinked: true, // 未接続タイル（260903_1）は既定で表示（従来どおりの見え方。灰色化のみ）
    autoRename: true, // 表示名の自動変更（260922_10）。config.json で false にすると止まる
  };
}

export class ProjectStore {
  private _projects: Project[] = [];
  private _config: AppConfig = defaultConfig();

  constructor(
    private readonly dataDir: string,
    private readonly logger: LoggerLike = nullLogger
  ) {}

  get projectsFile(): string {
    return path.join(this.dataDir, "projects.json");
  }

  get configFile(): string {
    return path.join(this.dataDir, "config.json");
  }

  get projects(): readonly Project[] {
    return this._projects;
  }

  get config(): AppConfig {
    return this._config;
  }

  /** 起動時ロード。ファイル欠落は既定値、パース失敗は既定値で継続（既存ファイルは上書きしない） */
  load(): void {
    try {
      if (fs.existsSync(this.projectsFile)) {
        const parsed = JSON.parse(fs.readFileSync(this.projectsFile, "utf8")) as {
          projects?: Project[];
        };
        this._projects = Array.isArray(parsed.projects) ? parsed.projects : [];
      }
    } catch (e) {
      this.logger.error(`projects.json の読み込みに失敗（空で継続・次回保存まで既存ファイルは温存）: ${String(e)}`);
      this._projects = [];
    }
    // 記憶したウィンドウ位置（260904_1 #3）: 壊れた値は捨てる（SetWindowPlacement に不正値を渡さない）
    for (const p of this._projects) {
      if (p.windowBounds === undefined) continue;
      const parsed = parseWindowBounds(p.windowBounds);
      if (parsed === null) {
        this.logger.warn(`projects.json の windowBounds が不正なため無視: ${p.name}`);
        delete p.windowBounds;
      } else {
        p.windowBounds = parsed;
      }
    }
    try {
      if (fs.existsSync(this.configFile)) {
        const parsed = JSON.parse(fs.readFileSync(this.configFile, "utf8")) as Partial<AppConfig>;
        this._config = { ...defaultConfig(), ...parsed };
      }
    } catch (e) {
      this.logger.error(`config.json の読み込みに失敗（既定値で継続）: ${String(e)}`);
      this._config = defaultConfig();
    }
    // MVP では通知音は常に無効（REQ-12 / spec.md AC-18。UI からも変更不可）
    this._config.notifySound = { enabled: false };
    // 旧バージョンの config.json（customStatuses 欠落）や壊れた値は既定の選択肢で補完（260727_1）
    if (!Array.isArray(this._config.customStatuses) || this._config.customStatuses.some((s) => typeof s !== "string")) {
      this._config.customStatuses = defaultConfig().customStatuses;
    }
    // 旧 config.json（showUnlinked 欠落）や壊れた値は「表示」に倒す（260903_1。タイルが黙って消えない側）
    if (typeof this._config.showUnlinked !== "boolean") {
      this._config.showUnlinked = true;
    }
    // クリック先（261005_1）: 手編集・未知の値は従来の既定（cursor / 既定なし）へ戻す
    if (this._config.defaultClickTarget !== undefined && !isClickTarget(this._config.defaultClickTarget)) {
      delete this._config.defaultClickTarget;
    }
    for (const p of this._projects) {
      if (!isClickTarget(p.clickTarget)) p.clickTarget = "cursor";
    }
  }

  /**
   * D&D 登録（REQ-01 / design.md 3.2(a)）。
   * 検証は validateProjectDir に集約（実在ディレクトリ・重複なし）。name はフォルダ basename を既定とする。
   */
  addProject(dirPath: string, clickTarget: ClickTarget = "cursor"): AddProjectResult {
    const valid = validateProjectDir(dirPath, this._projects);
    if (!valid.ok) {
      return { ok: false, error: valid.error };
    }
    const project: Project = {
      id: this.newId(),
      name: path.basename(dirPath),
      path: dirPath,
      clickTarget,
      registeredAt: new Date().toISOString(),
    };
    this._projects.push(project);
    this.saveProjects();
    return { ok: true, project };
  }

  /** デモ実行専用: 実在検証をせずに追加する（--demo のみ。通常経路では使わない） */
  addProjectDirect(project: Project): void {
    this._projects.push(project);
    this.saveProjects();
  }

  removeProject(id: string): Project | null {
    const idx = this._projects.findIndex((p) => p.id === id);
    if (idx < 0) return null;
    const [removed] = this._projects.splice(idx, 1);
    this.saveProjects();
    return removed;
  }

  getProject(id: string): Project | null {
    return this._projects.find((p) => p.id === id) ?? null;
  }

  setClickTarget(id: string, target: ClickTarget): boolean {
    const p = this._projects.find((x) => x.id === id);
    if (!p || !isClickTarget(target)) return false;
    p.clickTarget = target;
    this.saveProjects();
    return true;
  }

  /**
   * 一括変更（261005_1）: 全プロジェクトのクリック先を揃え、以後の新規登録の既定にもする。
   * 戻り値 = 変更したプロジェクト数（不正値は何もしない = -1）
   */
  setAllClickTargets(target: ClickTarget): number {
    if (!isClickTarget(target)) return -1;
    let changed = 0;
    for (const p of this._projects) {
      if (p.clickTarget === target) continue;
      p.clickTarget = target;
      changed += 1;
    }
    this._config.defaultClickTarget = target;
    this.saveConfig();
    if (changed > 0) this.saveProjects();
    return changed;
  }

  /** 手動ステータスの割り当て（260727_1）。null で解除。選択肢に無い値は拒否する */
  setCustomStatus(id: string, status: string | null): boolean {
    const p = this._projects.find((x) => x.id === id);
    if (!p) return false;
    if (status !== null && !this._config.customStatuses.includes(status)) return false;
    if (status === null) delete p.customStatus;
    else p.customStatus = status;
    this.saveProjects();
    return true;
  }

  /**
   * 手動ステータスの選択肢を丸ごと更新（260727_1）。空白のみ・重複は除去する。
   * 選択肢から消えたステータスは、使用中プロジェクトからも解除する
   * （メニューで再選択できないラベルをタイルに残さない）。
   */
  setCustomStatuses(list: string[]): void {
    const cleaned = [...new Set(list.map((s) => s.trim()).filter((s) => s !== ""))];
    this._config.customStatuses = cleaned;
    let projectsChanged = false;
    for (const p of this._projects) {
      if (p.customStatus !== undefined && !cleaned.includes(p.customStatus)) {
        delete p.customStatus;
        projectsChanged = true;
      }
    }
    this.saveConfig();
    if (projectsChanged) this.saveProjects();
  }

  setTheme(theme: ThemeSetting): void {
    this._config.theme = theme;
    this.saveConfig();
  }

  setAlwaysOnTopDefault(value: boolean): void {
    this._config.alwaysOnTopDefault = value;
    this.saveConfig();
  }

  /** 未接続タイルの表示／非表示（260903_1）。ステータスバーのトグルから呼ばれ、再起動後も保持する */
  setShowUnlinked(value: boolean): void {
    this._config.showUnlinked = value;
    this.saveConfig();
  }

  /**
   * 表示名の変更（260903_2）。前後の空白を除き、空ならフォルダ名（path の basename）へ戻す。
   * path は変えないため、前面化・切断検知・cwd 対応付け（いずれも path 基準）には影響しない。
   * auto=true は AI（Claude Sonnet）が自動で付けた名前（260922_10）。適用時刻を残し、同じ名前を何度も付け直さない。
   */
  renameProject(id: string, name: string, auto = false): RenameResult {
    const p = this._projects.find((x) => x.id === id);
    if (!p) return { ok: false, error: "プロジェクトが見つかりません" };
    const trimmed = name.trim();
    if (trimmed.length > PROJECT_NAME_MAX) {
      return { ok: false, error: `表示名は ${PROJECT_NAME_MAX} 文字以内にしてください` };
    }
    p.name = trimmed === "" ? path.basename(p.path) : trimmed;
    if (auto) p.nameAutoAt = new Date().toISOString();
    this.saveProjects();
    return { ok: true, name: p.name };
  }

  /**
   * タイルの並び順の変更（260906_1: D&D 並べ替え・自動整列）。並び順 = projects.json の配列順そのもの。
   * ids の順に並べ、未知の id は無視、ids に無い既存プロジェクトは元の相対順で末尾に残す（増減しない）。
   * 順序が変わらなければ保存せず false を返す
   */
  reorderProjects(ids: readonly string[]): boolean {
    const byId = new Map(this._projects.map((p) => [p.id, p] as const));
    const next: Project[] = [];
    for (const id of ids) {
      const p = byId.get(id);
      if (p !== undefined && !next.includes(p)) next.push(p);
    }
    for (const p of this._projects) {
      if (!next.includes(p)) next.push(p);
    }
    if (next.every((p, i) => p === this._projects[i])) return false;
    this._projects = next;
    this.saveProjects();
    return true;
  }

  /** ウィンドウ位置の記憶／消去（260904_1 #3）。null で記憶を消す。不正値は拒否 */
  setWindowBounds(id: string, bounds: WindowBounds | null): boolean {
    const p = this._projects.find((x) => x.id === id);
    if (!p) return false;
    if (bounds === null) {
      delete p.windowBounds;
    } else {
      const parsed = parseWindowBounds(bounds);
      if (parsed === null) return false;
      p.windowBounds = parsed;
    }
    this.saveProjects();
    return true;
  }

  private newId(): string {
    for (;;) {
      const id = "p-" + crypto.randomBytes(2).toString("hex");
      if (!this._projects.some((p) => p.id === id)) return id;
    }
  }

  private ensureDir(): void {
    fs.mkdirSync(this.dataDir, { recursive: true });
  }

  private saveProjects(): void {
    this.ensureDir();
    writeFileAtomic(this.projectsFile, JSON.stringify({ version: 1, projects: this._projects }, null, 2) + "\n");
  }

  private saveConfig(): void {
    this.ensureDir();
    writeFileAtomic(this.configFile, JSON.stringify(this._config, null, 2) + "\n");
  }
}

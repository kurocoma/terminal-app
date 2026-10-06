/**
 * main / preload / renderer で共有する型定義（型のみ。実行時コードなし）。
 * 対応設計: design.md 9 章（データ設計）・5 章（状態管理）
 */

/** クリックで前面化する対象アプリ。orca = Orca（stablyai/orca。261005_1） */
export type ClickTarget = "cursor" | "terminal" | "orca";

/**
 * 内部状態 = 待機（補助状態）＋確定 4 状態（design.md 5.1）＋切断（260712_2）。
 * 切断 = 「実行中」なのに transcript の更新が途絶し（ウィンドウ消失を併用判定）、
 * SessionEnd も届いていないセッション。liveness-monitor が検知して遷移させる。
 */
export type SessionState = "waiting" | "running" | "done" | "confirm" | "error" | "disconnected";

export type ThemeSetting = "light" | "dark" | "auto";

export type WindowAction = "minimize" | "maximize" | "close" | "restart";

/** projects.json の 1 エントリ（design.md 9 章） */
export interface Project {
  id: string;
  name: string;
  path: string;
  clickTarget: ClickTarget;
  registeredAt: string;
  /**
   * 手動ステータス（260727_1）。自動検知の SessionState とは別レイヤーのユーザー付与ラベル。
   * config.customStatuses の中から右クリックメニューで選択する。未設定 = ラベルなし
   */
  customStatus?: string;
  /**
   * 記憶したウィンドウ位置（260904_1 #3）。タイル右クリック「ウィンドウ位置を記憶」で
   * 対象アプリ（Cursor / ターミナル）のウィンドウ配置を保存し、「立ち上げる」直後や
   * 「記憶した位置へ戻す」で SetWindowPlacement により再現する。未設定 = 記憶なし
   */
  windowBounds?: WindowBounds;
  /**
   * AI（Claude Sonnet）が自動で付けた表示名の適用時刻（ISO 8601。260922_10）。
   * 一度自動で付けた名前は付け直さない（提案のたびに名前が揺れるのを防ぐ）
   */
  nameAutoAt?: string;
}

/**
 * ウィンドウ配置（260904_1 #3）。GetWindowPlacement の通常時矩形（rcNormalPosition）＋最大化フラグ。
 * 座標は保存・復元とも同じ API を使うため、モニタ構成が同じ限り忠実に再現できる
 */
export interface WindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
  maximized: boolean;
  /** 記憶した日時（ISO 8601）。設定画面の表示用 */
  savedAt: string;
}

/** config.json（design.md 9 章） */
export interface AppConfig {
  version: number;
  port: number;
  theme: ThemeSetting;
  alwaysOnTopDefault: boolean;
  /** REQ-12（次期）用の予約キー。MVP では常に false・UI から変更不可 */
  notifySound: { enabled: boolean };
  /** 手動ステータスの選択肢（260727_1）。設定画面で自由に追加・削除できる */
  customStatuses: string[];
  /**
   * 未接続タイル（260903_1: 対象アプリのウィンドウが無いタイル）を表示するか。
   * false = 灰色タイルをグリッドから隠す。ステータスバーのトグルで切り替え、再起動後も保持
   */
  showUnlinked: boolean;
  /**
   * 表示名の自動変更（260922_10）。Jev が「名前が作業を表していない」と判定したプロジェクトの表示名を
   * Claude Sonnet の提案で自動的に付け替える。false で止められる（config.json を編集。既定 true）
   */
  autoRename?: boolean;
  /** Codex のローカル履歴を読み取り、登録済みプロジェクトのタイルに表示する。既定 true */
  monitorCodex?: boolean;
  /**
   * 新規登録するプロジェクトのクリック先（261005_1）。設定画面の「一括変更」で選んだ値を引き継ぐ。
   * 未設定 = cursor（従来どおり）
   */
  defaultClickTarget?: ClickTarget;
}

/** セッション状態（メモリのみ・揮発。design.md 9 章） */
export interface SessionView {
  sessionId: string;
  projectId: string;
  /** 未指定は従来の Claude Code。Codex は独立した読み取り監視から届く */
  provider?: "claude" | "codex";
  /** 終了を確認したターミナルの履歴。生存・未確認の場合は省略し、分割表示の対象から外す */
  terminalClosed?: boolean;
  state: SessionState;
  /** 最終イベント時刻（epoch ms）。相対時刻表示の起点 */
  lastEventAt: number;
  /** 「実行中」へ遷移した時刻（epoch ms）。経過時間表示の起点（design.md 5.1） */
  runningSince?: number;
  lastMessage?: string;
  /**
   * 現在の作業テキスト（260712 課題B）。UserPromptSubmit hook の prompt（実データ）を整形した値。
   * ターミナルのオレンジ表示（スピナー行）そのものは hook / transcript に載らないため、
   * 「このセッションに何をやらせているか」を示す最も新しい実データとして prompt を用いる
   * （260712_3: TaskCreated の task_subject でも更新される）。
   */
  workText?: string;
  /**
   * statusLine 転送由来の作業メトリクス（260712_3 案A）。
   * 例「↓ 70.5k tokens · thinking xhigh」。取得不能・未転送時は undefined（非表示）。
   */
  statsText?: string;
  /**
   * 品質ループ（eval-loop）の進捗バッジ文言（260907_2）。例「ループ 2/4・codex 実装中 1分・最高 78点」、
   * 終了後 30 分は「ループ終了・合格 92点」。eval-loop の registry / state.json 由来。無ければ undefined（非表示）。
   */
  loopText?: string;
  /**
   * 確認待ちの種別（260922_2）。"permission" = Notification hook 由来（権限確認・入力待ち）、
   * "question" = Stop 後に Jev が「Claude の最後の返答がユーザーへの質問・判断依頼で終わっている」と判定したもの。
   * 表示は confirm と同じ（青の点滅・左上）だがラベルが「返答待ち」になる。confirm 以外では undefined
   */
  confirmKind?: "permission" | "question";
  /**
   * 確認待ちの危険度の印（260922_2）。Jev が許可待ちのツール呼び出しを「取り消せない操作」「外部へ送る操作」
   * 「広範囲に影響」と判定したときの文言（「・」区切り）。該当なし・判定なしは undefined（非表示）
   */
  dangerText?: string;
  /**
   * 停滞の疑いの印（260922_2）。実行中セッションの直近の手順を Jev が「同じ失敗を繰り返し」「進展なし」と
   * 判定したときの文言。実行中以外・判定なしは undefined（非表示）
   */
  stallText?: string;
  /**
   * このセッションが今やっているタスク（260922_10）。Claude Code が transcript に書く ai-title 由来で、
   * 会話が進むと更新される。分割タイルでもセッションごとに違う内容が出る。無ければ undefined
   */
  taskTitle?: string;
  /**
   * サブエージェント（バックグラウンドエージェント）待ちの印（260922_8）。
   * 本体のターンは終わっているが裏でエージェントが動いている間、タイルは「実行中」のままこの文言を出す。
   * 実行中以外・該当なしは undefined（非表示）
   */
  bgText?: string;
  /**
   * タイル名と作業内容の不一致の印（260922_6）。Jev が「名前が作業を表していない」「名前と作業が一致しない」と
   * 判定したときの文言。右クリック →「表示名を AI に提案」で直せる。該当なし・判定なしは undefined（非表示）
   */
  nameHint?: string;
  /**
   * このセッションを最初に観測した時刻（epoch ms。260904_1 #3）。
   * 同じプロジェクトで複数セッションが並行するときの分割タイルの並び順（起動順）に使う
   */
  firstSeenAt?: number;
}

/** ステータスバー件数（REQ-10 / design.md 5.2） */
export interface StatusCounts {
  running: number;
  done: number;
  confirm: number;
  error: number;
  /** 切断セッション数（260712_2）。既存テスト・呼び出し側との互換のためオプショナル（未設定 = 0 扱い） */
  disconnected?: number;
  /** 表示中セッション数（表示タイルごとに 1 つ。分割タイルはそれぞれ数える。待機タイルは数えない） */
  total: number;
}

/** main → renderer へ配信する全量スナップショット */
export interface Snapshot {
  revision: number;
  projects: Project[];
  /** key = projectId。プロジェクトの表示セッション（直近イベント優先。design.md 5.2） */
  sessions: Record<string, SessionView>;
  /**
   * 分割タイル（260904_1 #3）。key = projectId、value = そのプロジェクトで生きているセッションが
   * 2 本以上あるときの一覧（起動順）。キーが無いプロジェクトは従来どおり sessions の 1 タイル表示。
   * 生死は Claude Code のセッション登録簿（~/.claude/sessions）と PID 存在で判定する
   */
  splitSessions: Record<string, SessionView[]>;
  /** ステータスバー件数（REQ-10）。main が表示タイル基準で数え、renderer は表示整形のみ行う */
  counts: StatusCounts;
  config: AppConfig;
  pinned: boolean;
  statusMessage: string;
  /**
   * ウィンドウ有無（260903_1）。key = projectId、value = クリックで開く対象アプリ（Cursor / ターミナル）の
   * ウィンドウが見つかったか。main が約 5 秒ごとに判定する。キーが無い = 判定不能（koffi 未ロード等）で、
   * renderer は「接続あり」扱いにする（安全側）。未接続の最終判定は renderer の isUnlinked（format.ts）
   */
  windowPresence: Record<string, boolean>;
  /**
   * Orca でスリープ中のプロジェクト（261005_4）。key = projectId。Orca 対象で、Orca に登録済みかつ
   * 生きているターミナルが 0 のとき true。renderer は未接続（灰色）の代わりに「スリープ中」と表示する
   */
  sleeping?: Record<string, boolean>;
}

export interface RegisterResult {
  ok: boolean;
  path: string;
  projectId?: string;
  error?: string;
}

/**
 * D&D ドロップの生ペイロード（260727_1）。
 * Cursor（VS Code 系）からのドラッグは OS の File が付かないため、
 * renderer は DataTransfer の中身を丸ごと main へ渡し、main 側で
 * パス抽出（drop-paths.ts）と診断ログ出力を行う。
 */
export interface DropPayload {
  /** webUtils.getPathForFile で解決できた実ファイルパス（エクスプローラからのドロップ） */
  filePaths: string[];
  /** dataTransfer.types の一覧（診断ログ用） */
  types: string[];
  /** type → getData(type) の値（先頭 8000 文字。フォールバック抽出＋診断ログ用） */
  data: Record<string, string>;
}

export interface OpResult {
  ok: boolean;
  error?: string;
}

/** focusProject のオプション（260925_1: タッチ操作時のポインター迷子対策） */
export interface FocusProjectOptions {
  /** タッチ／ペンでタイルを押した（前面化後にポインターを対象ウィンドウへ移す） */
  viaTouch?: boolean;
  /**
   * 押したタイル（分割タイルはその枠）のセッション（261005_1）。Orca では窓が 1 枚のため、
   * このセッションが動いている Orca 内のターミナルタブへ切り替える手掛かりにする
   */
  sessionId?: string;
}

export interface FocusResult {
  ok: boolean;
  message?: string;
}

/** Orca のターミナル画面（261005_2） */
export interface OrcaScreenResult {
  ok: boolean;
  message?: string;
  lines?: string[];
  /** セッション ID で正確に特定できたか。false（推定）のときは返信・中断を送らない */
  exact?: boolean;
}

/** 指示の履歴の 1 件（261005_3） */
export interface InstructionItem {
  text: string;
  /** 送った時刻（epoch ms）。不明なら省略 */
  at?: number;
}

/** Orca へ送る入力（261005_2）。escape = 中断（Esc キー） */
export type OrcaInputPayload = { kind: "text"; text: string } | { kind: "escape" };

/** preload が window.terminalApp として公開する API */
export interface TerminalAppApi {
  getSnapshot(): Promise<Snapshot>;
  registerProjects(paths: string[]): Promise<RegisterResult[]>;
  /** D&D ドロップの生ペイロードを渡して登録する（260727_1: パス抽出は main 側で行う） */
  registerDrop(payload: DropPayload): Promise<RegisterResult[]>;
  /**
   * フォルダ選択ダイアログでプロジェクトを登録する（260727_1）。
   * Cursor のツリーからの D&D は OS ドラッグにパス情報が載らず対応不能のため、確実な代替導線
   */
  pickProjects(): Promise<RegisterResult[]>;
  /** D&D 診断ログを main のログファイルへ送る（260727_1。renderer コンソールは非表示運用のため） */
  dndLog(msg: string): void;
  unregisterProject(id: string): Promise<OpResult>;
  setClickTarget(id: string, target: ClickTarget): Promise<void>;
  /** 全プロジェクトのクリック先を一括変更し、以後の新規登録の既定にもする（261005_1） */
  setAllClickTargets(target: ClickTarget): Promise<void>;
  /** 指示の履歴（261005_3）: そのセッションでユーザーが送った指示を新しい順に（sessionId 未指定は代表セッション） */
  sessionInstructions(id: string, sessionId?: string): Promise<{ ok: boolean; items: InstructionItem[] }>;
  /** Orca のターミナル画面を読む（261005_2。sessionId 未指定は代表セッション） */
  orcaReadScreen(id: string, sessionId?: string): Promise<OrcaScreenResult>;
  /** Orca のターミナルへ返信・中断を送る（261005_2。セッションを正確に特定できたときだけ送る） */
  orcaSend(id: string, sessionId: string | undefined, input: OrcaInputPayload): Promise<FocusResult>;
  /** 右クリック →「Orca: 画面を見て返信…」（main → renderer） */
  onOrcaPanelRequest(cb: (projectId: string, sessionId: string | null) => void): void;
  /** 手動ステータスの割り当て（260727_1）。null = 解除 */
  setProjectStatus(id: string, status: string | null): Promise<void>;
  /** 手動ステータスの選択肢一覧を丸ごと更新（260727_1）。追加・削除とも本 API に集約 */
  setCustomStatuses(list: string[]): Promise<void>;
  /** 表示名の変更（260903_2）。空はフォルダ名へ戻す。上限超過などは ok=false + error */
  setProjectName(id: string, name: string): Promise<OpResult>;
  /** 未接続タイルの表示／非表示（260903_1）。config.json に保持 */
  setShowUnlinked(value: boolean): Promise<void>;
  /**
   * タイルの並び順を変更（260906_1: D&D 並べ替え・自動整列）。ids の順が projects.json の配列順になる。
   * 未知の id は無視、含まれない既存プロジェクトは末尾に元の順で残る。順序が同じなら何もしない
   */
  reorderProjects(ids: string[]): Promise<OpResult>;
  setTheme(theme: ThemeSetting): Promise<void>;
  setAlwaysOnTopDefault(value: boolean): Promise<void>;
  setPinned(value: boolean): Promise<void>;
  focusProject(id: string, options?: FocusProjectOptions): Promise<FocusResult>;
  /**
   * タイル以外の場所でタッチ／ペンの接触が終わった（260925_2: Windows が隠したポインターを再表示する。
   * 位置は変えない。戻り値なし・待たない）
   */
  notifyTouchEnded(): void;
  /**
   * タイルの右クリックメニューを表示（260712_2: 再接続・表示クリア・登録解除）。
   * sessionId は分割タイル（260904_1 #3）のときだけ渡す — 「この枠を消す」の対象になる
   */
  showTileMenu(id: string, sessionId?: string): Promise<void>;
  /** 全プロジェクトのウィンドウ位置を一括で記憶（260904_1 #3）。結果はステータスバーにも出る */
  saveAllWindowBounds(): Promise<OpResult>;
  /** 記憶済みの全プロジェクトのウィンドウを記憶位置へ戻す（260904_1 #3） */
  restoreAllWindowBounds(): Promise<OpResult>;
  /** restart はアプリ自体を再起動する（main 側で確認ダイアログを挟む）。 */
  windowAction(action: WindowAction): void;
  /** NFR-01 計測用: スナップショット描画完了を main へ通知（受信→描画のログ差分計測） */
  notifyRendered(revision: number): void;
  onSnapshot(cb: (snap: Snapshot) => void): void;
  /** タイル右クリック →「表示名を変更…」で main から届く。renderer 側で入力ダイアログを開く（260903_2） */
  onRenameRequest(cb: (projectId: string) => void): void;
  /** Electron 32+ で File.path が廃止されたため webUtils 経由でパスを得る */
  getPathForFile(file: File): string;
}

declare global {
  interface Window {
    terminalApp: TerminalAppApi;
  }
}

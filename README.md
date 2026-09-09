# terminal-app

Claude Code の並行セッションを監視する Windows 11 常駐タイルダッシュボード（Electron）。
**どのセッションが止まったかをひと目で識別し、1 クリックで対象ウィンドウ（Cursor / ターミナル）に切り替える。**

- 要件: `docs/spec.md`（REQ / NFR / AC / OPEN の正本）
- 設計: `docs/design.md`（モジュール分割・hooks 連携・UI はモック面 1a〜1f 準拠）
- 検証: `docs/verification.md`（V-01〜V-20）／実行記録: `docs/verification-results.md`

## 動作要件

- Windows 11 / Node.js 22+ / npm
- `curl.exe`（Windows 10+ 同梱。hooks からのイベント送信に使用）

## セットアップ

```
npm install
npm run build
```

## 起動

```
npm start
```

### 他の PC への導入（クローンから起動まで）

```
git clone https://github.com/kurocoma/terminal-app.git
cd terminal-app
npm install
npm run build
start-app.bat
```

- 前提は Node.js 22+ と `curl.exe`（Windows 10+ 同梱）だけ。設定・登録情報は `%APPDATA%\terminal-app\` に PC ごとに作られる
  （リポジトリには含まれない）。
- 起動後にプロジェクトのフォルダをウィンドウへドラッグ&ドロップすると、そのフォルダの `.claude/settings.json` に hooks が
  自動追記されて監視が始まる（既存設定は保全・バックアップ付き）。
- 品質ループ（eval-loop）の進捗バッジは `%USERPROFILE%\.claude\eval-loop\` がある PC でだけ出る。無ければ単に非表示になる。
- 2 回目以降の起動は `start-app.bat` だけでよい（ビルド済みなら再ビルドしない）。

- フォルダをウィンドウへドラッグ&ドロップするとプロジェクトが登録され、
  対象の `.claude/settings.json` に **Stop / Notification / UserPromptSubmit の 3 イベント**の
  hooks が自動追記される（既存設定は保全・バックアップ `settings.json.terminal-app.bak` 作成・冪等。
  UserPromptSubmit はプロンプト送信＝実行開始の検知用 — タイルが「実行中」（スピナー＋経過時間）になる）。
- **起動時追補**: アプリ起動時に登録済み全プロジェクトの hooks を冪等に再マージし、不足イベントのみ
  追記する。旧 2 イベント構成で登録済みのプロジェクトにも**再登録なしで** UserPromptSubmit が行き渡る。
- 自アプリ分の hooks は command 内の URL パス `/terminal-app/event` で識別する（`terminal-app` を
  パスに含むだけのユーザー自身の hook は除去・置換の対象にならない）。
- タイルをクリックすると、そのプロジェクトに設定した対象（Cursor / ターミナル）を前面化する。
- **未接続タイル**: クリックで開く対象アプリ（Cursor / ターミナル）でそのフォルダを開いているウィンドウが
  見つからないタイルは灰色で表示される（約 5 秒ごとに判定。実行中・確認待ちのタイルは誤判定で隠さないよう対象外）。
  ステータスバー右端の「未接続を表示」トグルで非表示にでき、設定は再起動後も保持される。
  右クリック →「立ち上げる」で対象アプリを開くと数秒で通常表示に戻る。
- **表示名**: タイル右クリック →「表示名を変更…」または設定画面の ✎ で、フォルダ名とは別の表示名を付けられる
  （空にするとフォルダ名へ戻る。前面化・切断検知の対象探索はフォルダ名のまま）。
  手動ステータスのバッジ（作業中／レビュー待ち等）は表示名の下の行に出る（260904_1 #1）。
- **確認待ちの見え方と復帰（260904_1 #2）**: 確認待ちのタイルは青で 1 秒周期に点滅する。完了・切断・確認待ち復帰の
  見直し（掃引）は 15 秒ごと。権限確認を許可して Claude が作業を再開した（transcript が更新された／Claude Code の
  登録簿 status が busy になった）ことを掃引で検知し、タイルは自動で「実行中」に戻る。
- **作業中の完了・切断誤判定の防止（260907_1）**: 品質ループ等で Stop hook が block されて Claude が続行した場合や、
  同期 fork・codex 待ちで本体 transcript が長く止まる場合でも、タイルを「実行中」に保つ（戻す）。根拠は Claude Code の
  登録簿 status=busy（cli 起動）、transcript の block 痕跡（`stop_hook_summary.preventedContinuation`。Cursor 起動でも使える）、
  subagent 記録（`<sessionId>/subagents/agent-*.jsonl`）の更新。Stop 受信で「完了」にした約 3.5 秒後に判定して
  まだ作業中なら「実行中」へ戻し、完了トーストはその判定の後に出す（block された Stop で誤通知しない）。
  登録簿が busy の間は切断判定をしない。block で戻ったタイルの作業テキストは block 理由のラベル（例「[Eval-loop iteration 1/4 | RESUME 1/3]」）。
- **ループ進捗バッジ（260907_2）**: 品質ループ（eval-loop）が動いているセッションのタイルには、名前の下に
  「ループ 2/4・codex 実装中 1分・最高 78点」のような青いバッジが出る（周回数は 1 始まり。段階は 計画中／実装中／採点中／判定中、
  codex ジョブが走っていればその役割と経過分。最高点は 2 周目以降）。ループが終わると「ループ終了・合格 92点」
  （上限到達／停止／時間切れ／停滞で停止／採点不能）を 30 分間だけ表示する。情報源は eval-loop プラグイン v0.2 が書く
  `<セッションの cwd>\.mso\sessions\<sessionId>\state.json`（直列）と `.mso\agents\<agentId>\state.json`（fork。state の session_id で対応付け）、
  codex ジョブは `turns\turn-NNN-<plan|generator>-progress.log`（PHASE_END が無く 150 秒以内に更新）。15 秒ごとの掃引で更新（260908_1 で `.mso` 配置へ追従）。
- **作業継続中の保持（260908_1）**: 品質ループの司令塔は codex を Monitor で待つ間、通知が来るたびに短く応答して終える。
  そのたびに Stop hook と入力待ち Notification が届き、タイルが「完了」「確認待ち」に倒れてトーストが鳴っていた。
  次の 2 つの根拠があるあいだは Stop・入力待ち通知を受けても「実行中」を保ち、終了検知・切断検知の対象からも外す:
  (1) そのセッションの品質ループが進行中（`.mso` の state.json が active。codex 進捗ログが動いていれば無条件、
  止まっていれば state / 進捗ログ / transcript のどれかが 30 分以内に動いたこと）、
  (2) 直近のプロンプトがバックグラウンドタスクの通知（`<task-notification>` による自動起床）で、Claude Code の登録簿 status が
  idle / waiting 以外（例: バックグラウンドの shell が残っている `shell`）。通知による起床では作業テキストを上書きしない。
  許可要求の Notification はループ中でも「確認待ち」（人の応答が要る）。保持が解けて完了になったとき（ループ終了・バックグラウンド作業終了）に
  初めて完了トーストを出し、ループが終わっていれば本文に「ループ終了・合格 92点」を添える。
- **残骸 state の無視と通知種別の公式化（260908_2）**: eval-loop プラグインはサブエージェント起動時に `.mso/agents/<id>/state.json` を
  active=true で事前作成し、ループを使わなかったサブエージェントの分は閉じられずに残ることがある（task が空のまま）。
  この残骸を「ループ進行中」と読んでタイルが回り続けたため、task 未設定の state は存在しないものとして扱う（バッジ・保持ともに対象外。
  プラグインの loop-control.sh と同じ規則）。Notification の種別は公式の `notification_type`
  （permission_prompt / idle_prompt / elicitation_* / agent_needs_input 等）で判定し、無いときだけ文言で推定する。
- **入力待ちの誤「切断」防止と SessionStart（260909_1）**: 入力待ちのまま `/effort` `/model` などのローカルコマンドを打つと transcript が動き、
  それをターン開始と誤読して「実行中」へ戻り、15 分後に「切断」へ倒れていた。ローカルコマンドの痕跡は終端分類で読み飛ばし、
  確認待ちからの transcript 復帰は本当にターンが始まった（終端 open）ときだけにする。登録簿 status が idle のまま transcript が
  3 分止まった「実行中」は「完了」へ倒し、idle のセッションは切断判定の対象外にする（生きて入力待ちは切断ではない）。
  あわせて hooks に **SessionStart** を追記（起動時追補で既存プロジェクトにも行き渡る）: 新しいセッションが始まったら、同じフォルダの
  「切断」「終了済み」の表示を消してタイルを待機へ戻す（Claude Code 再起動後に前セッションの「切断・N分前」が残らない）。
- **分割タイル（260904_1 #3）**: 1 つのフォルダで 2 本以上の claude が同時に動いている（Cursor の複数ターミナル等）と、
  タイルが「名前 ①」「名前 ②」（起動順）に自動で分かれ、それぞれの状態・作業テキストが見える。1 本に戻れば元の 1 タイルへ。
  生死は Claude Code 自身が書く登録簿（`%USERPROFILE%\.claude\sessions\<pid>.json`）とプロセス存在で判定するため、
  ターミナルを閉じれば約 30 秒以内（掃引 2 回）に枠が消える。分割タイルの右クリック →「この枠を消す」で手動でも消せる。
  ステータスバーの件数は表示タイル基準。
- **ウィンドウ位置の記憶／復元（260904_1 #3）**: タイル右クリック →「ウィンドウ位置」→「今のウィンドウ位置を記憶」で
  Cursor / ターミナルのウィンドウ配置（位置・サイズ・最大化）を `projects.json` に保存し、「記憶した位置へ戻す」で再現する。
  設定画面の「ウィンドウ位置」に全プロジェクト一括の記憶／復元ボタンがある（アップデート等で全部閉じたあとの復帰用）。
  右クリック →「立ち上げる」で開いた直後は、ウィンドウが現れ次第（最大 60 秒待ち）記憶した位置へ自動で動かす。
  記憶した位置がどのモニタにも掛からないときは復元しない。
- **タイルの並べ替えと自動整列（260906_1）**: タイルをドラッグして別のタイルの左半分（手前）／右半分（直後）へ落とすと
  並び替わる（分割タイル ①② はプロジェクト単位で一緒に動く）。タイトルバーの「自動整列」ボタンは、接続中のタイルを
  左上へ・未接続を末尾へ寄せる（各グループ内の相対順は維持。押したときの 1 回だけ）。並び順は `projects.json` の
  配列順そのもので、再起動後も保持される。
- 登録解除は設定画面（歯車アイコン）の各プロジェクト行の × ボタン。自アプリ分の hooks のみ除去する。
- トースト通知・サウンドは次期スコープ（REQ-12）。設定 UI は無効表示のみで音は鳴らない。

## テスト・検証

| コマンド | 内容 |
|----------|------|
| `npm test` | 単体・統合テスト（Vitest。hooks マージ/除去・状態遷移・HTTP 受信・永続化） |
| `npm run typecheck` | main / renderer / tests の型検査 |
| `npm run lint` | ESLint |
| `npm run smoke:win32` | Win32 FFI（ウィンドウ列挙・前面化 API）のスモーク確認 |
| `node scripts/verify-injection.mjs <出力先>` | デモ起動＋擬似イベント注入（UserPromptSubmit→実行中を含む）＋バインド確認（verification.md 3.4 / 3.7）を自動実行し証跡を残す |
| `node scripts/verify-upgrade.mjs <出力先>` | 旧 2 イベント構成サンドボックスへの起動時追補（before/after）と UserPromptSubmit 注入→実行中表示を実測し証跡を残す（実 %APPDATA%・実プロジェクトに非接触） |
| `node scripts/verify-real-session.mjs <出力先>` | 実 `claude -p` セッション＋マージ済み実 hook コマンドで、hooks 整備→実行中→完了→再起動保持→未起動時の無害性を通しで実測し証跡を残す（専用ポートで実稼働アプリと共存） |
| `node scripts/verify-foreground.mjs <出力先>` | 実ターミナルウィンドウを開き、前面化（V-09 #8）と最小化からの復元＋前面化（#9）を GetForegroundWindow / IsIconic で実測する（実行中は一瞬フォーカスが移る） |
| `node scripts/verify-unlinked-rename-e2e.mjs [出力先]` | デモ起動を CDP（remote-debugging）で操作し、未接続タイルの灰色表示・トグル非表示・config 保持と、表示名の変更ダイアログ（保存／上限拒否／空でフォルダ名復帰）を実 IPC 往復で確認し、スクリーンショットを残す |
| `node scripts/verify-split-blink-e2e.mjs [出力先]` | デモ（16 タイル）を CDP で開き、バッジが名前の下の行にあること・確認待ちが青の点滅（computed style）・同じプロジェクトの 2 セッションが ①② の分割タイルになること・件数が表示タイル基準・設定画面のウィンドウ位置ボタンを確認し、スクリーンショットを残す（260904_1） |
| `node scripts/verify-liveness-registry-e2e.mjs [出力先]` | 非デモの専用インスタンスに実 hook 形式のイベントを注入し、実登録簿（`~/.claude/sessions`）に無い架空セッションが掃引 2 回で終了確定 → 切断 → 破棄され分割が解けること、確認待ち → transcript 更新で「実行中」へ復帰することを実測する（登録簿に生きている claude が必要。260904_1） |
| `node scripts/verify-arrange-e2e.mjs [出力先]` | デモ（12 タイル）を CDP で開き、自動整列で接続中 10 件が先頭・未接続 2 件が末尾になること、再押下で「整列済み」案内、合成 DragEvent によるタイルの D&D（手前／直後の両方向・自分自身へのドロップ無視）、`projects.json` への並び順の永続化、内部ドラッグ中は登録用オーバーレイが出ず外部ファイルのドロップでは出ることを確認し、スクリーンショットを残す（260906_1） |

検証・証跡用の起動フラグ（`npx electron . <flags>`）:

- `--demo` — モック面 1b 相当の 12 タイルをシードして起動（一時データディレクトリ使用。実設定・実 hooks に触れない）
- `--demo-count=16` — 16 タイル（NFR-05 の確認用。棚割り-app が 2 セッションの分割タイル例を含む）
- `--view=settings` — 設定画面を初期表示
- `--theme=light|dark|auto` — テーマの一時上書き
- `--capture=<path> [--capture-delay=<ms>]` — スクリーンショット PNG を保存して自動終了

## 構成（design.md 3.1 のモジュール分割に対応）

```
src/
  main/
    event-server.ts    … ① イベント受信サーバ（127.0.0.1:41321、POST /terminal-app/event）
    state-store.ts     … ② 状態ストア（スキーマ検証・4 状態遷移・cwd 最長一致・直近セッション優先）
    project-store.ts   … ② の永続化（%APPDATA%\terminal-app\projects.json / config.json）
    hooks-manager.ts   … ④ hooks 設定マネージャ（settings.json の安全マージ/除去・バックアップ・アトミック書き込み）
    window-control.ts  … ⑤ ウィンドウ制御（koffi/user32: EnumWindows・SetForegroundWindow・復元・Get/SetWindowPlacement）
    session-registry.ts … Claude Code のセッション登録簿（~/.claude/sessions）による生死判定（260904_1）
    liveness-monitor.ts … 15 秒周期の掃引ロジック（終了検知・切断検知・確認待ちからの復帰）
    window-bounds.ts   … 記憶したウィンドウ位置（projects.json）の検証・整形
    index.ts           … 結線・BrowserWindow・IPC・多重起動禁止・受信→描画レイテンシログ
    demo.ts / logger.ts / paths.ts / constants.ts
  preload/index.ts     … contextBridge（window.terminalApp）
  renderer/            … ③ UI（タイルグリッド / 空状態 / 設定 / ステータスバー。モック 1a〜1f 準拠）
tests/                 … Vitest（verification.md 5 章の単体・統合枠）
scripts/               … build 補助・スモーク・注入検証
```

## データ・ログの場所

- 設定・登録情報: `%APPDATA%\terminal-app\`（`projects.json` / `config.json`）
- ログ: `%APPDATA%\terminal-app\logs\app.log`（日次ローテーション・7 日保持）
- 環境変数 `TERMINAL_APP_DATA_DIR` でデータディレクトリを差し替え可能（テスト・デモ用）
- 環境変数 `TERMINAL_APP_WINDOW_POLL_MS` で未接続タイル判定（ウィンドウ列挙）の間隔を変更可能（既定 5000ms。検証用）
- 環境変数 `TERMINAL_APP_LIVENESS_INTERVAL_MS` で掃引（終了・切断・確認待ち復帰・登録簿の生死判定）の間隔を変更可能（既定 15000ms。検証用）

## 既知の制約（MVP）

- アプリ未起動中のイベントは取りこぼす（design.md 3.3 の採用仕様）
- エラー検知の網羅範囲（クラッシュ等）は OPEN-03 として技術検証待ち。受信形式は design.md 4.8 で定義済み
- セッション状態は揮発（再起動で全タイル「待機」に戻る）

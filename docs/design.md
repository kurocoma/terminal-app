# terminal-app 詳細設計書

| 項目 | 内容 |
|------|------|
| 版 | 0.1（初版） |
| 作成日 | 2026-07-11 |
| 上位文書 | 要件定義書 `spec.md`（REQ/NFR/AC/OPEN の採番正本） |
| UI の正 | UI モック観察記録 `.loop/current/context-design-mock.md`（面番号 1a〜1f） |
| 検証 | `verification.md`（AC ⇔ 検証項目対応表） |

表記規約: 未確定事項（spec.md 9 章 OPEN-xx）に依存する設計判断には **「推奨（未確定）」** を付す。確定扱いにしない。

## 1. 設計方針

対応要件: 全体（特に NFR-02, NFR-03）

1. **Claude Code を絶対に阻害しない** — hook コマンドは短タイムアウト・失敗容認（4.6 節）。
2. **`.claude/settings.json` を壊さない** — バックアップ＋アトミック書き込み＋マーカー方式の可逆マージ（4.1〜4.2 節）。
3. **UI はモック 1a〜1f を正とする** — 独自解釈で足す要素は「モック未記載・設計追加」と明記する（6 章）。
4. **未確定は未確定のまま設計する** — スタック依存の記述は複数案併記とし、非依存部を厚くする。

## 2. 技術スタック（OPEN-01: 複数案併記＋推奨（未確定））

対応要件: REQ-07（常駐）, REQ-05（Win32 呼び出し）, OPEN-01

| 観点 | 案 A: Electron | 案 B: Tauri (v2) |
|------|----------------|------------------|
| UI 実装 | HTML/CSS/JS（モックの CSS 表現をほぼ流用可能） | 同左（WebView2 利用） |
| ローカル HTTP 受信 | Node `http` 標準モジュールで容易 | Rust（axum/tiny_http 等）で容易 |
| settings.json の読み書き | Node で容易 | Rust serde_json で容易 |
| Win32 呼び出し（前面化） | koffi / ffi 系ネイティブモジュールが必要 | `windows` crate で直接呼べる（型安全） |
| メモリ・配布サイズ | 大きい（常駐アプリとしては重め） | 小さい（常駐向き） |
| 実装言語 | TypeScript のみで完結 | Rust + TypeScript の 2 言語 |
| D&D・トレイ・常に手前 | 標準 API で対応 | 標準 API で対応 |

**推奨（未確定）: 案 A: Electron。** 理由: TypeScript 単一言語で hooks 受信・JSON マージ・UI・テストまで完結し、実装速度と保守性で有利。常駐メモリの重さは NFR-07（アイドル CPU）には抵触しない。ただし spec.md OPEN-01 のとおり**実装着手時に比較提案のうえユーザーが選択**する。本書の 3 章以降はスタック非依存に記述し、依存箇所のみ「Electron の場合／Tauri の場合」を併記する。

> **確定（2026-07-11 追記）**: 上記の比較提示の結果、ユーザー選択により **案 A: Electron で確定**（OPEN-01 解消）。以降の実装は Electron + TypeScript を前提とする。本章の比較表は選定記録として残す。

## 3. アーキテクチャ

対応要件: REQ-02, REQ-03, REQ-05, NFR-01, NFR-04

### 3.1 構成図

罫線は等幅フォントでもずれない ASCII のみで描く（2026-07-11 修正。全角文字を罫線位置に揃えない方針）。

```
+- プロジェクト A（例 C:\dev\zaiko-app）
|    Claude Code セッション
|      +- hooks（Stop / Notification / UserPromptSubmit）
|           +- curl.exe --> HTTP POST（stdin の JSON をそのまま転送）
+---------------+
                | http://127.0.0.1:41321/terminal-app/event
                v
+- terminal-app 常駐プロセス（Windows 11）
|    ① イベント受信サーバ（127.0.0.1 のみバインド）
|    ② 状態ストア（プロジェクト×セッションの状態モデル）
|    ③ UI（タイルグリッド / 設定 / 空状態）← モック 1a〜1f
|    ④ hooks 設定マネージャ（settings.json マージ/除去）
|    ⑤ ウィンドウ制御（Win32: 前面化・常に手前）
|    永続化: %APPDATA%\terminal-app\（projects.json 等）
+----------------
```

### 3.2 主要シーケンス

**(a) プロジェクト登録（REQ-01, REQ-02）**

```
ユーザー: フォルダを D&D
→ ③UI: パス検証（ディレクトリであること・重複登録でないこと）
→ ④: .claude/settings.json を読み込み → バックアップ → hooks 断片をマージ → アトミック書き込み
→ ②: projects.json に追加 → ③: タイル追加（状態 = 待機）
失敗時: settings.json に一切書き込まず、UI にエラー表示（登録も行わない）
```

**(b) イベント受信 → タイル更新（REQ-03, REQ-04, NFR-01）**

```
Claude Code: Stop/Notification/UserPromptSubmit 発火 → hook コマンド実行（stdin に JSON）
→ curl.exe が ① へ POST（タイムアウト 2 秒）
→ ①: JSON 検証 → ②: cwd からプロジェクト特定（4.7）→ 状態遷移（5.1）
→ ③: タイル再描画＋発光開始、ステータスバー更新（受信から 1 秒以内）
```

**(c) タイルクリック → 前面化（REQ-05, REQ-06）**

```
ユーザー: タイルをクリック（このとき本アプリがフォアグラウンド）
→ ⑤: プロジェクト設定の clickTarget（cursor|terminal）に応じ対象ウィンドウを探索（7.1）
→ 最小化なら復元（SW_RESTORE）→ SetForegroundWindow（7.2）
→ 失敗時: ステータスバーに「ウィンドウが見つかりません」表示
```

### 3.3 イベント伝達方式の選定

| 案 | 概要 | 評価 |
|----|------|------|
| **ローカル HTTP（採用）** | hook から `curl.exe`（Windows 10+ 同梱）で 127.0.0.1 の固定ポートへ POST | 追加依存なし・実装単純・stdin JSON をそのまま転送できる |
| ファイル書き込み＋監視 | hook がスプールファイルを書き、アプリが watch | アプリ未起動でも取りこぼさない利点はあるが、掃除・競合処理が増える |
| 名前付きパイプ | Win32 named pipe | hook 側クライアントの用意が煩雑 |

採用: **ローカル HTTP**。既定ポート **41321**（`config.json` で変更可。変更時は登録済み全プロジェクトの hooks を書き換えて再追記する）。アプリ未起動時のイベントは取りこぼす仕様とする（MVP 許容 — 起動中の監視が目的のため。NFR-02 の無害性を優先）。

## 4. hooks 連携設計

対応要件: REQ-02, REQ-03, NFR-02, NFR-03, OPEN-03, OPEN-04

### 4.1 追記する settings.json 断片

登録時、プロジェクトの `.claude/settings.json` に以下をマージする。対象イベントは
**Stop / Notification / UserPromptSubmit の 3 つ**（2026-07-11 改訂: OPEN-04 案 A の採用により
UserPromptSubmit を追加 — 4.5 参照）。

**識別マーカー = command 文字列に含まれる URL パス `/terminal-app/event`**。除去時はこのマーカーで
自アプリ分のみを特定する（2026-07-11 改訂: 旧「`terminal-app` の部分一致」判定は、ユーザー自身の
hook コマンドが本リポジトリのパス等（例 `...\dev\terminal-app\scripts\notify.js`）を含む場合に
誤除去しうるため、送信 URL パス一致へ厳格化した。既設エントリの command は URL を含むため互換で、
移行処理は不要）:

```json
{
  "hooks": {
    "Stop": [
      { "hooks": [ { "type": "command",
        "command": "curl.exe -s -m 2 -o NUL -X POST http://127.0.0.1:41321/terminal-app/event -H \"Content-Type: application/json\" --data-binary @-",
        "timeout": 5 } ] }
    ],
    "Notification": [
      { "hooks": [ { "type": "command",
        "command": "curl.exe -s -m 2 -o NUL -X POST http://127.0.0.1:41321/terminal-app/event -H \"Content-Type: application/json\" --data-binary @-",
        "timeout": 5 } ] }
    ],
    "UserPromptSubmit": [
      { "hooks": [ { "type": "command",
        "command": "curl.exe -s -m 2 -o NUL -X POST http://127.0.0.1:41321/terminal-app/event -H \"Content-Type: application/json\" --data-binary @-",
        "timeout": 5 } ] }
    ]
  }
}
```

hook の stdin には Claude Code が `session_id` / `cwd` / `hook_event_name` / `transcript_path`（Notification では `message` も）を含む JSON を渡すため、コマンド側での加工は不要（`--data-binary @-` で転送）。

### 4.2 マージ / 除去手順（NFR-03: 壊さない）

**マージ（登録時）**
1. `.claude/settings.json` が無ければ `{}` から開始（`.claude/` ディレクトリは作成）。
2. 読み込み→ JSON パース。**パース失敗時は何も書かずに中断**し、UI にエラー表示（壊れたファイルを上書きしない）。
3. `settings.json.terminal-app.bak` としてバックアップ（登録操作ごとに上書き）。
4. `hooks.Stop` / `hooks.Notification` / `hooks.UserPromptSubmit` 配列に対し、マーカー
   `/terminal-app/event` を command に含むエントリが**無い場合のみ**上記断片のエントリを append する
   （既存エントリは順序含め変更しない。冪等）。
5. 一時ファイルに書き出し → rename でアトミックに置換。

**除去（登録解除時）**
1. パース失敗時は中断（手動対応を促す）。
2. `hooks.Stop` / `hooks.Notification` / `hooks.UserPromptSubmit` から、command に `/terminal-app/event` を含む hook のみを取り除く。空になった配列・空になった `hooks` キーは削除して痕跡を残さない。
3. バックアップ→アトミック書き込みはマージ時と同じ。

**起動時追補（2026-07-11 追加 — 既存登録プロジェクトへのアップグレード経路）**

アプリ起動時、登録済み全プロジェクトに対して上記マージを冪等に再適用する。マーカー付きエントリが
不足しているイベントだけが append されるため、**旧 2 イベント（Stop / Notification）構成で登録済みの
プロジェクトにも、再登録なしで UserPromptSubmit が行き渡る**（OPEN-04 案 A の既存環境への適用手段）。
バックアップ・アトミック書き込み・冪等・パース失敗時中断・他者エントリ非破壊は登録時マージと
同一経路のため同じ保証が効く。ポート変更後の再追記（3.3）もこの経路に含まれる。

### 4.3 イベント → 状態のマッピング表

| hooks イベント | 判定条件 | 遷移先状態 | 備考 |
|----------------|----------|-----------|------|
| Stop | 無条件 | **完了** | 応答が終わり入力待ちに戻った |
| Notification | `message` が許可要求（permission 系） | **確認待ち** | ツール実行許可で停止中 |
| Notification | `message` が入力待ちアイドル通知 | **確認待ち** | 質問・放置の検知 |
| Notification | 上記以外の message | **確認待ち**（安全側に倒す） | message 文字列の種別判定は実装時に実物で検証する |
| UserPromptSubmit | 無条件 | **実行中** | プロンプト送信＝実行開始（OPEN-04 案 A 採用 — 4.5。2026-07-11 追加） |

### 4.4 エラー検知の限界と扱い（OPEN-03: 未確定）

プロセスクラッシュ・強制終了は Stop/Notification hooks だけでは拾えない可能性がある。**MVP は「検知できた範囲のみエラー表示」とし、網羅範囲は実装時に技術検証する**（verification.md 9 章に検証タスクあり）。なお、受信側の「エラー相当イベント」のペイロード形式は **4.8 で定義済み**（これにより verification.md V-16 は擬似注入で実行可能）。候補案（併記・網羅範囲はいずれも未確定）:

| 案 | 概要 | 懸念 |
|----|------|------|
| 案 A | SessionEnd 系 hook の終了理由からエラー相当を判定 | 取得できる理由の粒度が要検証 |
| 案 B | 実行中セッションのプロセス生存監視（PID 追跡） | hooks 経由で PID を確実に得る方法が要検証 |
| 案 C | 「実行中のまま長時間イベントなし」をエラー疑いとして表示 | 誤検知（長時間タスク）とのトレードオフ |

### 4.5 「実行中」への遷移の検知（OPEN-04: **案 A 採用で確定** — 2026-07-11）

Stop / Notification だけでは「新しいプロンプトを送って作業が再開した」ことを検知できない。

- **案 A — UserPromptSubmit hook を追加で追記する: 採用（確定）。** プロンプト送信＝実行開始を正確に検知でき、モック 1a の経過時間表示（1:24:01 等）の起点になる。確定事項「検知は hooks（Stop / Notification）を使用」の置き換えではなく補助追加である。
- 案 B — Stop / Notification のみで運用。初回イベントまでタイルは「待機」、完了後に再開しても次のイベントまで「完了」のまま。経過時間の代わりに最終イベントからの相対時刻を表示。

> **確定（2026-07-11 追記）**: MVP 1 周目（案 B 相当で出荷）に対するユーザー実測フィードバック
> 「返信（Stop）での状態変化は確認できたが、**プロンプトを送信しても何も変わらない**ので分かりづらい」
> を受け、**案 A を採用**（OPEN-04 解消。spec.md 9 章・verification.md 9 章に同記録）。
> 実装は (1) 4.1 の追記断片へ UserPromptSubmit を追加、(2) 受信側は 4.8 のとおり対応済み、
> (3) 既存登録プロジェクトへは 4.2 の**起動時追補**で再登録なしに適用、の 3 点で構成する。
> 発火タイミング・二重発火の実測は擬似注入＋起動時追補の実測で代替確認した
> （`docs/verification-results.md`。実 Claude Code セッションでの発火確認は手動枠として残る）。

### 4.6 Claude Code を阻害しない工夫（NFR-02）

- `-m 2` で最大 2 秒、hook 自体の `timeout: 5` で二重に上限。
- curl の失敗終了コードは exit 2 ではないため、Stop hook の続行をブロックしない（Claude Code は exit 2 のみをブロック扱いにする）。シェル差異（cmd / PowerShell / Git Bash）で挙動が変わらないかは実装時に確認し、必要なら「常に exit 0」のラッパを付ける。
- **V-14 実測所見（2026-07-11 更新）**: 本マシンでは「接続拒否で即失敗」にはならず、アプリ停止中は
  `-m 2` 上限までの約 2.0 秒タイムアウト失敗（exit 28。exit 2 ではない = 非ブロック）となる。
  `--connect-timeout` の追加で短縮できることを実測で確認した:
  `--connect-timeout 1` で約 1.0 秒 / `--connect-timeout 0.5` で約 0.52 秒（いずれも exit 28。
  Windows 同梱 curl 8.19.0、3 回計測。`docs/verification-results.md` / evidence の
  `hook-noapp-timeout.log`）。hook コマンドへの採用は挙動変更（command 文字列の変更 → 全登録の
  置き換え）を伴うため今回は見送り、短縮候補として記録する。採用時は 4.2 の起動時追補（マージ）が
  旧 command のマーカー付きエントリを新 command へ自動で置き換えるため、移行手当は不要。

### 4.7 cwd → プロジェクトの対応付け

受信 JSON の `cwd` を、登録プロジェクトのパスと**最長一致プレフィックス**（大文字小文字非区別・区切り正規化）で照合する。サブディレクトリで起動したセッションも親プロジェクトのタイルに割り当てる。一致しない場合は破棄しログにのみ記録する。

### 4.8 イベント受信スキーマ（正式定義）

対応要件: REQ-03, NFR-04, OPEN-03, OPEN-04（2026-07-11 追記 — 前ループ持ち越し課題 1 の反映。これにより verification.md V-16 が実行可能になった）

**エンドポイント**: `POST http://127.0.0.1:<port>/terminal-app/event`（Content-Type: application/json。他パスは 404・他メソッドは 405 — 10 章）

**受理するペイロード（v1）**

| フィールド | 型 | 必須 | 内容 |
|-----------|----|------|------|
| `hook_event_name` | string | ○ | `Stop` / `Notification` / `UserPromptSubmit` / `SessionEnd` のいずれか |
| `session_id` | string（非空） | ○ | Claude Code のセッション ID |
| `cwd` | string（非空） | ○ | セッションの作業ディレクトリ（4.7 の対応付けに使用） |
| `message` | string | — | Notification の通知文（4.3 の種別分類に使用） |
| `reason` | string | — | SessionEnd の終了理由（下記のエラー相当判定に使用） |
| `transcript_path` | string | — | 参考情報（MVP では未使用） |

**不正 JSON の判定条件**（いずれかに該当したら HTTP 400 で破棄し、ログにのみ記録する。UI は変えない — 10 章）

1. JSON としてパースできない
2. ルートがオブジェクトでない
3. 必須フィールド（`hook_event_name` / `session_id` / `cwd`）の欠落・型不一致・空文字
4. `hook_event_name` が上記 4 種以外（未知イベント）

**エラー相当イベントのペイロード形式（OPEN-03 のうち「形式」の暫定確定）**

- `hook_event_name: "SessionEnd"` かつ `reason` が正常終了（`clear` / `logout` / `prompt_input_exit` / `exit`）**以外**、または `reason` 欠落 → 「エラー」へ遷移する。
- 正常終了 `reason` の SessionEnd は状態を変えない（破棄・ログのみ）。
- settings.json に自動追記するのは 4.1 のとおり Stop / Notification / UserPromptSubmit の 3 イベント（SessionEnd は追記しない。2026-07-11 改訂: OPEN-04 案 A 採用で UserPromptSubmit を追加）。本定義は V-16 の擬似注入の実行と、OPEN-03 の技術検証で SessionEnd hook 追記を採用した場合の受け口である。**検知の網羅範囲そのもの（クラッシュ等で何が発火するか）は引き続き OPEN-03**（4.4）。
- `UserPromptSubmit` は受信で「実行中」へ遷移する。2026-07-11 の OPEN-04 案 A 採用（4.5）により hooks への自動追記対象（4.1）。既存登録プロジェクトへは起動時追補（4.2）で適用される。

## 5. 状態管理・遷移設計

対応要件: REQ-04, REQ-08, spec.md 5 章

### 5.1 状態遷移表

内部状態 = 待機（イベント未受信の補助状態・無発光）＋確定 4 状態。

| 現在状態 ＼ 入力 | Stop | Notification | 実行開始（UserPromptSubmit。OPEN-04 案 A 採用） | エラー検知（OPEN-03 の範囲） |
|------------------|------|--------------|----------------------------------|------------------------------|
| 待機 | 完了 | 確認待ち | 実行中 | エラー |
| 実行中 | 完了 | 確認待ち | 実行中（継続） | エラー |
| 確認待ち | 完了 | 確認待ち（時刻更新） | 実行中（許可後の再開） | エラー |
| 完了 | 完了（時刻更新） | 確認待ち | 実行中 | エラー |
| エラー | 完了（復帰扱い） | 確認待ち | 実行中 | エラー |

- 経過時間（実行中）: 「実行中」へ遷移した時刻を起点に 1 秒毎更新（案 A 採用により確定。4.5）。
- 相対時刻（完了・確認待ち・エラー）: 最終イベント時刻からの相対表示（「たった今」「2分前」…）。1 分未満は「たった今」。
- セッション状態は**揮発**とする。アプリ再起動後は全タイル「待機」に戻る（MVP 許容）。
- **hook 以外の入力による遷移**（掃引 15 秒。5.2 参照）: 実行中 → 完了（終了検知 260712_4）／実行中 → 切断（切断検知 260712_2）／
  確認待ち → 実行中（復帰 260904_1 #2）／**完了・切断 → 実行中（復帰 260907_1）**。Stop による「完了」は即時だが、
  約 3.5 秒後の前倒し判定で「まだ作業中」（登録簿 status=busy・block 痕跡）なら取り消して「実行中」へ戻す。
  完了トーストはこの判定の後に出す。

### 5.2 複数セッションの直近イベント優先（spec.md 5.4）

- セッションは `session_id` 単位で保持し、タイルは**最終イベント時刻が最新のセッション**の状態を表示する（260712 課題A で「実行中」優先、260904_1 #3 で「生存」優先を追加）。
- ステータスバーの件数（REQ-10）は表示中セッション（プロジェクトごとに 1 つ）を数える。モック 1a/1b の「12 セッション」表記と一致させる。
- **分割タイル（260904_1 #3）**: 同じプロジェクトで**生きている**セッションが 2 本以上あるときだけ、セッションごとに 1 タイル（「名前 ①②」起動順 = 最初の観測時刻順）に分ける。1 本以下に戻れば従来の 1 タイルへ。件数は表示タイル基準（分割はそれぞれ 1 件）。
- **生死判定（260904_1 #3）**: Claude Code 自身が書く登録簿 `%USERPROFILE%\.claude\sessions\<pid>.json`（v2.1.259 実測。終了時に消える）と PID 存在で判定する（`session-registry.ts`）。登録簿に無い／PID が死んだセッションは 15 秒周期の掃引で 2 回連続観測後に「終了済み」とし、分割対象から外す。同じプロジェクトに生存セッションがあれば記録ごと破棄、無ければ従来どおり「完了・N分前」の表示を残す。実行中のまま終了していれば「切断」へ。登録簿が無い環境（旧版）では従来の hook / transcript 判定のみ。
- **作業中の完了・切断誤判定の防止（260907_1）**: 品質ループ（eval-loop）で (a) 司令塔が途中で応答を終える → eval-loop の Stop hook が block して続行、でも本アプリの Stop hook は同時に「完了」を送る、(b) 同期 fork（`background: false` の Skill）や codex 待ちで本体 transcript が 15 分以上止まり「切断」になる、の 2 経路が実測された（2026-09-07。登録簿 status は Stop と同じ秒に idle、Esc でも idle、ターン中は同期 fork の間も busy 継続）。対策は掃引に「完了・切断 → 実行中」の復帰判定（`liveness-monitor.findResumedFromStopped`）を足し、Stop 受信の約 3.5 秒後にも同じ判定を前倒しで 1 回行う（`index.ts` の `scheduleStopRecheck`）。根拠は 3 系統: **R1** 登録簿 status=busy かつ transcript 終端が concluded でない（busy が古いまま残る事故への保険。Stop から 3 秒未満は判定しない）／**R2** transcript の最新 `stop_hook_summary` が `preventedContinuation=true` で最終イベント−2 秒以降（block の痕跡。Cursor 起動でも使える。作業テキストは stopReason の先頭 `[...]`）／**R3** 切断中に本体または subagent 記録（`<sessionId>/subagents/agent-*.jsonl`）が更新。切断判定は登録簿 busy の間は行わず、無更新の判定には subagent 記録の mtime も含める（`session-scan.activityMtimeMs`）。`classifyTurnEnd` は `preventedContinuation=true` を open（ターン継続）と分類し、`turn_duration` 単独では決めない。完了トーストは前倒し判定の後（最大 3.5 秒遅れ）に出す。既知の限界: Stop hook 群の完了に 3.5 秒以上かかると登録簿がまだ busy のため一度「実行中」へ戻り、次の掃引の終了検知（10 秒以上無更新＋終端 concluded）で「完了」に戻る（その場合の完了トーストは出ない）。E2E 用に登録簿ディレクトリは env `TERMINAL_APP_SESSIONS_DIR` で差し替え可能。
- **ループ進捗バッジ（260907_2）**: 品質ループ（eval-loop ハーネス v3）がディスクに書く事実だけを情報源にする（`eval-loop-status.ts`）。`~/.claude/eval-loop/registry/sessions/<sessionId>`（state.json の絶対パス 1 行）と `registry/agents/*`（fork・parallel ループ。state の `session_id` で対応付け）から state.json を読み、`active` / `iteration`（0 始まり → 表示は +1）/ `max_iterations` / `phase`（plan=計画中 / generator=実装中 / evaluator=採点中 / eval=判定中）/ `best_score` / `ended_reason` / `ended_at` を使う。codex ジョブは `jobs_dir/iter-NNN-<role>/` の `exit_code` 無し＋`heartbeat` 30 秒以内（または `started_at` から 20 秒未満）を走行中とみなし（`ll_job_status` と同規則）、段階を「codex 実装中／採点中 <経過分>分」に置き換える。同じセッションに進行中ループが複数あれば先頭＋「（他 N 本）」。終了後は `ended_at` から 30 分だけ「ループ終了・<理由> <点数>点」（threshold_met=合格 / max_iterations=上限到達 / cancelled=停止 / wall_clock_exceeded=時間切れ / stalled:*=停滞で停止 / invalid_eval_output=採点不能。never_started は出さない）。15 秒ごとの掃引で `StateStore.applyLoopText`（statusLine 転送と同じく状態遷移に触れない。値が変わったときだけ再描画）。読めない・壊れている state は黙って無視（バッジ無し）。env `TERMINAL_APP_EVAL_LOOP_DIR` で参照先を差し替え可能（E2E 用）。

## 6. 画面設計（UI モック 1a〜1f 準拠）

対応要件: REQ-04, REQ-07〜REQ-10, REQ-12, REQ-13, NFR-05, NFR-06

### 6.1 メイン画面 — 通常時（面 1a）／点灯時（面 1b）

- タイルグリッド: 最大 16 タイルまで折返し配置で破綻しないこと（NFR-05）。タイル寸法はモック準拠を基準とし、80px 詰め（16 面）は OPEN-05 の調整候補として保留。
- ステータスバー（下部）: `{n}実行中 {n}完了 {n}確認待ち {n}エラー / {N}セッション`。件数 0 の状態は省略（面 1b の表記に合わせる）。
- タイトルバー: **ピン留め（常に手前）** と **テーマ切替** のアイコン、最小化／最大化／閉じる（面 1a〜1f 共通）。閉じる = アプリ終了（トレイ常駐のコンパクト表示は OPEN-05 のため MVP では実装しない）。

### 6.2 タイル仕様（面 1a・1b のデザイン言語）

| 項目 | 仕様 |
|------|------|
| 質感 | **Stream Deck のキーキャップ**。上辺ハイライト＋下辺シャドウで「押せる」質感。ホバーで浮き、クリックで沈む（沈み＝前面化実行） |
| 発光 | **キーの下から漏れる光**。完了は約 **2.4 秒周期の「呼吸」**（CSS 例: `animation: breath 2.4s ease-in-out infinite`）。**確認待ちだけは 1 秒周期の点滅**（`blink 1s step-end`。260904_1 #2 ユーザー指示。光・アイコン・枠線を青に）。発光の強さ/速さの増強は OPEN-05 |
| 状態色 | 完了 = 緑（呼吸発光）／確認待ち = **青（アクセント色）で点滅**（260904_1 #2。旧: アンバーの呼吸）／エラー = **動かない赤**（アニメーションなし）／実行中 = ニュートラル＋スピナー／待機 = ニュートラル無発光（モック未記載・設計追加、5.1 参照） |
| 表示要素 | 1 行目: プロジェクト名（分割タイルは ①② の番号付き。260904_1 #3）／2 行目: 手動ステータスのバッジ（260727_1。260904_1 #1 で名前の横から下の行へ移動 — 名前と行を取り合わない）＋**ループ進捗バッジ**（260907_2。eval-loop の state から「ループ 2/4・codex 実装中 1分・最高 78点」、終了後 30 分は「ループ終了・合格 92点」。アクセント色のピル。無ければ非表示）／状態アイコン（✓ ? ⚠ スピナー）＋作業テキスト／状態ラベル＋相対時刻（「完了・2分前」）または経過時間（実行中 1:24:01） |
| 並べ替え | **タイルの D&D**（260906_1 #2）: ドロップ先タイルの左半分＝手前／右半分＝直後。挿入位置はアクセント色の縦線＋枠線で示す。内部ドラッグは専用 MIME（`application/x-terminal-app-tile`）で識別し、フォルダ登録の D&D（オーバーレイ）と混ざらない。分割タイルはプロジェクト単位で一緒に動く。**自動整列**（260906_1 #1。タイトルバーのボタン）: 接続中（`isUnlinked` でない。分割タイルはいずれか 1 本）のプロジェクトを左上へ、未接続を末尾へ。各グループ内の相対順は維持し、押下時の 1 回だけ行う（5 秒ごとのウィンドウ判定に追従して勝手に並び替えない）。並び順は projects.json の配列順そのもの（9 章）。**確認待ちを先頭へ**（260922_1）: renderer の `displayProjects` が `confirmFirstIds` / `projectConfirming`（format.ts）で確認待ちのプロジェクトを表示上だけ先頭に寄せる。projects.json は書き換えないため D&D・自動整列の基準はそのまま、確認待ちが解ければ元の位置へ戻る |
| 自己診断 | **直近の動作の確認**（260927_1）: `diagnose.ts`（純関数: `analyzeAppLog` / `checkSessionConsistency` / `overallLevel`）＋ `scripts/diagnose.mjs`（I/O）。ログは見出し単位で集計し、同じセッションで「復帰 → 終了検知」が FLIP_FLOP_WINDOW_MS(60s) 以内に交互に出たものを往復として数える。表示の整合は `sessions.json` の各セッションを 登録簿の生死・transcript 終端・subagent の新しさ と突き合わせる。受信サーバへの疎通だけ POST するが、架空 session_id と未登録 cwd を使うため表示は変わらない |
| タスク名・自動リネーム | **今やっているタスク**（260922_10）: `session-scan.aiTitleOf`（transcript の `{"type":"ai-title","aiTitle":…}` を新しい順に 1 件）を掃引で読み、`StateStore.applyTaskTitle` → タイルの名前の下に表示。transcript の mtime が変わったときだけ読み直す（`taskTitleRead`）。生成コストなし・セッション単位。**自動リネーム**: Jev の名前整合判定（260922_6）で印が付いたら `autoRenameProject` が `suggestProjectName`（sonnet）を呼び、確認なしで `renameProject(id, name, true)`。`Project.nameAutoAt` を記録して二度目は行わず、`autoRenameBusy` で同時実行を 1 件に制限、`config.autoRename=false` で無効化 |
| サブエージェント待ち | **裏で動いている間は実行中**（260922_8）: `session-scan.subagentMtimeMs`（subagent 記録だけの mtime。本体 transcript は Stop 直後の後片付けで動くため使わない）を`findResumedFromStopped` / `findResumedFromQuestion` に R5 として追加し、`lastEventAt + SUBAGENT_RESUME_MARGIN_MS(3s)` より新しければ「実行中」へ戻す。あわせて Jev の返答待ち判定に `delegated_background` を足し、閾値 0.7 以上で `background`（返答待ちが成立していれば返答待ちを優先）。どちらの経路でも `applyBgText` で「サブエージェント待ち」のバッジを出し、状態が実行中でなくなれば `clearJudgeMarks` が落とす |
| セッション表示の保存・復元 | **再起動をまたぐ継続**（260922_7）: `broadcast()` のたびに 3 秒間引きで `<dataDir>/sessions.json` へ保存（`will-quit` で書き切る）。保存単位は `StateStore.exportSessions()`（dead を除く。transcriptPath・questionSince など内部項目も含む）＋ 保存時の transcript mtime。起動時は `loadSessionSnapshot` → `reconcileSnapshot`（登録なし／登録簿 dead は捨てる、保存後に transcript が進んでいれば終端分類で作り直し Jev 由来の印を落とす、動いていなければそのまま）→ `importSessions`（既知の id は上書きしない）。その後に起動時復元（260922_3）が走り、保存に無かったセッションを transcript から拾う。版違い・破損・24 時間超過は無視して従来どおり作り直す |
| Jev 判定 | **制御層の門番**（260922_2）: `jev-client.ts`（TypeSafe API `POST /v1/systemone`。キーは env TYPESAFE_API_KEY → `%USERPROFILE%/.typesafe.env`。失敗は常に null）＋ `jev-judge.ts`（質問定義・閾値・解釈の純関数）＋ `session-scan.ts` の材料抽出（`lastAssistantTextOf` / `lastToolUseOf` / `recentStepsOf`）。4 判定: ①返答待ち = Stop 後の前倒し判定（STOP_RECHECK_DELAY_MS）で復帰しなかったとき最後の返答を noul 3 問（asks_user / wants_permission / is_report）で聞き、max(asks, perm) ≥ 0.7 かつ > is_report なら `markQuestionPending`（confirm / confirmKind=question。lastEventAt が進んでいれば適用しない）。②危険度 = Notification 受信後に最後の tool_use を noul 3 問（irreversible / external / broad_scope）で聞き ≥ 0.6 を「・」連結して `applyDangerText`。③作業テキスト = 前の作業テキストがあり prompt ≤ 40 文字のときだけ prompt を伏せて遷移し、is_task ≥ 0.5 なら `setWorkText`（判定不能は従来どおり置き換え）。④停滞 = 掃引ごとに実行中セッションの直近 16 手順（tool_use/tool_result/text）を noul 3 問で聞き、making_progress < 0.75 かつ repeating_failure / no_progress ≥ 0.75 で `applyStallText`。同じ活動時刻・60 秒未満は聞き直さない。**返答待ちの復帰**（260922_4）: `findResumedFromQuestion`（liveness-monitor）が掃引ごとに 登録簿 busy（終端が concluded でない）／block 痕跡／終端 open の 3 系統で `resumeFromConfirm` へ戻す。基準時刻は `questionSince`（返答待ちにした時刻。表示の起点 lastEventAt＝Stop の時刻とは別に持ち、Stop 直後の後片付けを再開と誤認しない）。`judgePendingQuestion` は適用直前にも同じ根拠で見送る。終了検知（Stop 未受信のターン完了）で完了にしたセッションも同じ判定にかける。⑤名前整合（260922_6）= 作業テキストを持つセッションごとに noul 3 問（matches / name_generic / work_is_topic）を聞き、work_is_topic ≥ 0.5 を前提に name_generic ≥ 0.8 または matches ≤ 0.45 で `applyNameHint`。判定は「表示名|作業テキスト」が変わったときだけ。改名は `name-suggest.ts` が Claude Code CLI（`claude -p --model sonnet`、Windows は cmd.exe 経由）に 1 行の名前を作らせ、確認ダイアログを経て `renameProject` → `clearNameHints`。印は状態遷移（イベント・復帰・切断・終了検知）で `clearJudgeMarks` が落とす。判定結果は全件 app.log（`Jev 〜判定:`）。デモ・TERMINAL_APP_JEV=off・キー無しは nullJevClient |

### 6.3 空状態（面 1c）

プロジェクト 0 件時: 「フォルダをここにドラッグ&ドロップ」「プロジェクトを登録すると、セッションの状態がタイルで表示されます」。ステータスバーは「0 セッション」。ウィンドウ全面が D&D 受け付け領域（登録後のメイン画面でも D&D 追加は常時有効）。

### 6.4 設定画面（面 1d、ライト版 = 面 1f）

| セクション | 項目 | MVP での扱い |
|-----------|------|--------------|
| 全般 | テーマ（ライト／ダーク／自動） | REQ-13（should）。UI は面 1d どおり配置。MVP 実装を見送る場合は既定ダーク固定とし選択肢を無効表示 |
| 全般 | 通知音（完了・確認待ちで音を鳴らす、トグル） | **REQ-12（次期）のため MVP では無効（操作不可）＋「次期対応」の注記を表示**。UI 自体は面 1d どおり残す（勝手に MVP へ昇格させない） |
| 全般 | 常に手前を規定にする（起動時にピン留めをオンにする、トグル） | must（REQ-07）。タイトルバーのピン留めは即時切替、本設定は起動時の既定値 |
| プロジェクト | プロジェクトごとに「クリックで開くアプリ: [Cursor｜ターミナル]」2 択トグル＋パス表示（例 `C:\dev\zaiko-app`） | must（REQ-06）。「他 10 件を表示」の折りたたみも面 1d どおり |
| プロジェクト | 登録解除ボタン（各行） | must（REQ-11）。**モック未記載・設計追加**（解除手段が UI に必要なため）。行末の控えめなアイコンとする |

### 6.5 ライトモード（面 1e・1f）

配色は CSS カスタムプロパティ（デザイントークン）で二値化し、ダーク（面 1a〜1d）を基準に、ライト（面 1e・1f）はトークン差し替えのみで実現する。状態色（緑／アンバー／赤）の識別性は両テーマで維持する。

## 7. ウィンドウ前面化設計

対応要件: REQ-05, REQ-06

### 7.1 対象ウィンドウの特定

| clickTarget | 探索対象 | 一致規則 |
|-------------|----------|----------|
| cursor | プロセス名 `Cursor.exe` の可視トップレベルウィンドウ | ウィンドウタイトルにプロジェクトのフォルダ名（basename）を含む（大文字小文字非区別） |
| terminal | `WindowsTerminal.exe`・`conhost.exe` 等のターミナル系プロセス | 同上（Windows Terminal はアクティブタブ名がウィンドウタイトルに出ることを利用） |

複数一致時は Z オーダー最前面（最近使ったもの）を選ぶ。**タイトル一致はヒューリスティック**であり（タブが背面のときや同名フォルダで外れうる）、精度は verification.md V-09 の手動検証で確認する。見つからない場合はステータスバーに「ウィンドウが見つかりません」を表示する（MVP では起動代行はしない）。

### 7.2 SetForegroundWindow の制約（Windows のフォアグラウンド制約）

Windows はバックグラウンドプロセスによるフォーカス奪取を制限する（`SetForegroundWindow` はフォアグラウンドプロセス等からの呼び出しのみ許可）。本アプリでは**ユーザーがタイルをクリックした瞬間は本アプリがフォアグラウンド**であるため、原則そのまま権限内で前面化できる。手順:

1. `IsIconic()` で最小化判定 → `ShowWindow(SW_RESTORE)`。
2. `SetForegroundWindow(hwnd)`。
3. 失敗時のフォールバック（順に試す）: `AttachThreadInput` でスレッド入力を接続して再試行 → ALT キー送出（`keybd_event`）でフォアグラウンドロックを解除して再試行。

実装手段: Electron の場合は koffi 等の FFI で user32.dll を呼ぶ／Tauri の場合は `windows` crate（OPEN-01 に従う）。

### 7.3 タッチ操作時のポインター迷子対策（260925_1）

タッチパネル（別画面）でタイルをタップすると、Windows はポインターを隠したうえ位置をタッチした画面に残すため、前面化した Cursor 側でポインターが見つからなくなる。renderer は `click` の `PointerEvent.pointerType` が `touch` / `pen` のときだけ `focusProject(id, { viaTouch: true })` を送り、main は前面化成功後に `GetWindowRect` の中央へ `SetCursorPos` と時間差付きの擬似マウス移動でポインターの再表示を試みる（`SetCursorPos` だけでは隠れたままになるため）。マウスクリック時は何もしない（ポインターを勝手に動かさない）。ポインター移動の失敗は前面化の結果に影響させない。

実機では即時 1 回の移動だけでは時々負けた（Windows のタッチ→マウス変換の遅延メッセージがポインターをタッチ位置へ戻す）。そのため即時に加えて 120 / 300 / 600 / 1000ms 後にも `GetCursorPos` で「まだ対象ウィンドウの矩形外にいるか」を確かめ、外にいる時だけ移し直す（中にいれば触らない＝ユーザーが動かし始めたマウスを邪魔しない）。遅延後にやり直した回数は app.log に出る。

260925_2 追補（実機ログで残っていた 3 つの取りこぼし）:

- **前面化に失敗したタップ**（ウィンドウ未検出など）でもポインターを再表示する。位置を遠くへ移さず、時間差付きの微小移動だけ送る（`PointerWarper.reveal`）。
- **タイル以外のタッチ**（スクロール・余白への接触）も renderer の `pointerup` / `pointercancel` から `notifyTouchEnded` で main へ伝え、同じく再表示する。
- **1 秒以内の連続タップ**では前のタップの再試行予約を取り消す（`PointerWarper.cancel`）。取り消さないと、前の予約が「前のウィンドウの外にいる」と判断して背面に回ったウィンドウへ引き戻す。
- 判断ロジックは `src/main/pointer-warp.ts`（Win32 非依存・テスト対象）、Win32 呼び出しは window-control の `PointerPort` 実装に分離。
- 診断: `GetCursorInfo` の flags（`CURSOR_SHOWING` / `CURSOR_SUPPRESSED`）で「表示中／タッチで抑制中」を直接読み、再試行の最後に「ポインター最終状態: (x,y) 対象内 / 表示中」の形で app.log に残す。最終時点でまだ抑制中なら念押しで再表示する。迷子が再発した時はこの行で「位置の問題」か「表示の問題」かを切り分ける。

2026-09-28 追補（対象内でも非表示のまま残るケース）:

- 実機ログで `対象内 / 非表示`（flags=0）が残ることを確認。矩形内なら再試行を省略し、最終時点も `CURSOR_SUPPRESSED` だけを回復対象にしていたため、通常の非表示を取りこぼしていた。
- 各再試行で位置と表示状態を別々に判定する。矩形内では再配置せず、flags=0 または抑制中なら擬似移動で再表示する。表示中なら操作しない。状態不明は非表示と断定しない。
- 通常の `pointerup → click` は `reveal → warpTo` の順。前の reveal 予約は取り消すが、warpTo が表示回復も引き継ぐ。連続タップ時の古い移動予約の取消は維持する。
- 最終の再表示直後に状態を読まず、100ms 後（開始から 1100ms）に観測してログに残す。新しいタップはこの観測予約も取り消す。入力送信が成功しても実際の描画回復を保証するものではなく、非表示が続く場合はそのまま記録する。

2026-09-28 追加修正（同期往復を時間差付き入力へ変更）:

- `src/main/pointer-pulse.ts` で、現在のモニターと `GetClipCursor` の範囲内に絶対座標で 2px 動かし、60ms 後に元へ戻す。`SendInput` の `MOVE | MOVE_NOCOALESCE | VIRTUALDESK | ABSOLUTE` を使い、負原点の仮想画面にも対応する。
- 復路は現在位置が往路の到達点と一致し、マウスボタンが押されていない場合だけ送る。新しいタップは古い復路を取り消す。微動を重ねず、右クリック・キー入力は追加しない。
- `SetCursorPos` の成功と `SendInput` の挿入件数を確認する。送信成功は再表示成功とは別であり、位置・表示フラグ・カーソル形状の有無・前面PID・直下ウィンドウPIDを観測する。
- `reveal` も最後の入力から100ms待って観測する。発火済みタイマーは予約集合から取り除く。
- この変更は再表示方式の改善。根本原因の確定や、全ての実タッチでの表示復帰を保証するものではない。
### 7.4 ターミナル終了と Codex 分割タイル（2026-09-28）

Codex の DB は会話履歴であり、ターミナルを閉じても残る。Windows の
`thread-writer-locks/<thread-id>.lock` を読み取り専用で開き、先頭 1 byte の読取が
ロック競合（EBUSY）なら生存、読取可能な残骸またはファイル消失なら終了候補とする。
Codex の writer ownership は [公式実装](https://github.com/openai/codex/blob/main/codex-rs/rollout/src/writer_lock.rs)、
ロック範囲の読取失敗は [ReadFile の仕様](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-readfile) に基づく。
監視側でロックを取得すると会話開始と競合するため、取得・作成・削除は行わない。
ディレクトリ自体がない旧版、Windows 以外、アクセス拒否は判定不能として扱う。

通常 5 秒周期で 2 回連続の終了候補を確認したら `terminalClosed` を付ける。
生存確認済みのセッションは応答完了後もタイルを維持し、終了履歴は別の生存セッションと分割しない。
全て閉じたプロジェクトは直近の終了履歴 1 枚に戻す。Claude の内部 `dead` も同じビュー属性へ
変換し、Claude / Codex を結合する際に終了履歴が分割へ復活することを防ぐ。
生存を再確認すれば終了印を外す。判定不能は連続終了カウントをリセットするが、確定済みの終了を
勝手に生存へ戻さない。未対応版の履歴表示と直近 24 時間の対象範囲は維持する。

終了を確認した Codex の履歴は、Claude と同じ未接続規則（対象アプリのウィンドウ無し → 灰色、
「未接続を表示」がオフなら非表示）に従う（260929_1）。開いている Codex は Cursor 外の CLI・アプリでも
動くため、ウィンドウが無くても未接続にしない。

## 8. 常駐・ウィンドウ挙動

対応要件: REQ-07

- 小さめのタイルウィンドウとして常駐。多重起動は禁止（既存インスタンスを前面化）。
- 常に手前: タイトルバーのピン留めで即時切替（Electron: `setAlwaysOnTop` / Tauri: `set_always_on_top`）。起動時の既定値は設定「常に手前を規定にする」に従う（面 1d）。
- OS スタートアップ登録・トレイ常駐は MVP 対象外（トレイのコンパクト表示は OPEN-05）。

## 9. データ設計（永続化ファイル）

対応要件: REQ-01, REQ-06, REQ-13, NFR-03

保存場所: `%APPDATA%\terminal-app\`（プロジェクト側に置くのは hooks 追記のみ）。

**projects.json**
```json
{ "version": 1, "projects": [ {
  "id": "p-8f3a", "name": "zaiko-app", "path": "C:\\dev\\zaiko-app",
  "clickTarget": "cursor", "registeredAt": "2026-07-11T06:00:00Z" } ] }
```
`name` はフォルダ basename を既定とする。`clickTarget` は `"cursor" | "terminal"`（既定 `"cursor"`）。
`projects` の**配列順 = タイルの表示順**（260906_1）。D&D 並べ替え・自動整列は `reorderProjects(ids)` で配列を並べ替えて保存する（順序用のキーは持たない。順序が同じなら保存しない）。

**config.json**
```json
{ "version": 1, "port": 41321, "theme": "auto",
  "alwaysOnTopDefault": false,
  "notifySound": { "enabled": false } }
```
`notifySound` は次期（REQ-12）用の予約キー。MVP では常に `false` で UI から変更不可。

**セッション状態（メモリのみ・揮発）**
```
Session { sessionId, projectId, state: "waiting"|"running"|"done"|"confirm"|"error",
          lastEventAt, runningSince?, lastMessage? }
```

いずれの書き込みも一時ファイル→rename のアトミック方式（NFR-03 と同方針）。

## 10. エラー処理・ログ

対応要件: NFR-02, NFR-03, NFR-04

| 事象 | 挙動 |
|------|------|
| 受信 JSON が不正／未知イベント | 破棄してログ記録（UI は変えない） |
| cwd がどのプロジェクトにも一致しない | 破棄してログ記録（4.7） |
| settings.json パース失敗 | 書き込まず中断、UI にエラー表示（4.2） |
| 前面化失敗（対象なし／API 失敗） | ステータスバーにメッセージ（7.1） |
| 受信ポート使用中 | 起動時にエラーダイアログを出し、設定でポート変更を案内（3.3） |

ログ: `%APPDATA%\terminal-app\logs\app.log`（ローテーションは日次・直近 7 日、個人利用前提の最小構成）。受信サーバは 127.0.0.1 のみバインドし、`/terminal-app/event` 以外のパスは 404（NFR-04）。

## 11. トレーサビリティ（REQ ⇔ 設計セクション）

| 要件 | 設計セクション |
|------|----------------|
| REQ-01（D&D 登録） | 3.2(a), 6.3, 9 |
| REQ-02（hooks 自動追記/除去） | 4.1, 4.2 |
| REQ-03（Stop/Notification 検知） | 3.2(b), 4.3〜4.7 |
| REQ-04（4 状態表示＋発光） | 5.1, 6.2 |
| REQ-05（クリックで前面化） | 3.2(c), 7 |
| REQ-06（Cursor/ターミナル選択） | 6.4, 7.1, 9 |
| REQ-07（常駐・常に手前） | 6.1, 6.4, 8 |
| REQ-08（タイル表示要素） | 5.1, 6.2 |
| REQ-09（空状態） | 6.3 |
| REQ-10（ステータスバー） | 5.2, 6.1 |
| REQ-11（登録解除） | 4.2, 6.4 |
| REQ-12（トースト/サウンド: 次期） | 6.4, 9（予約キーのみ。実装しない） |
| REQ-13（テーマ: should） | 6.4, 6.5 |
| REQ-14（履歴: could） | 設計対象外（次期候補） |
| REQ-15（D&D 並べ替え。260906_1） | 6.2, 9 |
| REQ-16（自動整列。260906_1） | 6.2, 9 |
| NFR-01（性能: 受信→反映 1 秒以内） | 3.2(b), 4.8 |
| NFR-02（無害性: Claude Code を阻害しない） | 4.6, 10 |
| NFR-03（settings.json を破壊しない） | 4.2, 9 |
| NFR-04（127.0.0.1 バインドのみ） | 3.3, 4.8, 10 |
| NFR-05（タイル 12〜16 で非破綻） | 6.1 |
| NFR-06（呼吸発光・エラーは静的な赤） | 6.2 |
| NFR-07（アイドル時 CPU ほぼ 0） | 8 |

## 12. 未確定事項の設計上の扱い（spec.md 9 章対応）

| ID | 本書での扱い |
|----|--------------|
| OPEN-01 | 2 章で比較＋推奨 → **2026-07-11 ユーザー選択により Electron で確定（解消）** |
| OPEN-02 | 6.4 で UI 無効表示、9 章で予約キーのみ。詳細設計はしない |
| OPEN-03 | 4.4 で候補案の併記に留める（網羅範囲は確定させない）。受信ペイロード形式のみ 4.8 で暫定確定 |
| OPEN-04 | 4.5 で案 A/B 併記＋案 A を推奨 → **2026-07-11 ユーザー実測フィードバックにより案 A（UserPromptSubmit 追加追記）を採用（解消）**。4.1 の断片へ追加・既存登録へは 4.2 の起動時追補で適用 |
| OPEN-05 | 6.1, 6.2, 8 で「保留」と明記（要件化しない） |

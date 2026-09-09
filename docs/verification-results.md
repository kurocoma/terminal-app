# terminal-app 検証実行記録（verification-results）

| 項目 | 内容 |
|------|------|
| 実施日 | 2026-07-11（初回）／同日 追記: OPEN-04 採用ループ（6 章） |
| 実施者 | Claude Code（eval-loop turn-000 実装フェーズ） |
| 対象 | Electron MVP 実装（`C:/Users/hppym/dev/terminal-app/`、Electron 37.10.3 / Node 22.18.0 / Windows 11） |
| 上位文書 | `verification.md`（V-xx の手順正本）／`spec.md`（AC-xx）／`design.md` |
| 証跡の場所 | 初回分: `.loop/archive-loop-20260711-162831/turns/turn-000-evidence/`（アーカイブ済み）。OPEN-04 採用ループ分（6 章）: `.loop/current/turns/turn-000-evidence/`（以下「evidence/」と表記） |

判定の凡例:

- **成功** — 自動テストまたは実行証跡で合否基準を満たした
- **部分実施** — ローカルで実行可能な範囲は実施して合格。残りは実 Claude Code セッション・実ウィンドウ・目視が必要（未実施範囲と手動手順を明記）
- **未実施** — 今回は実行していない（理由と手動手順を明記）

本記録は verification.md 7 章の実施記録（`verification-log.md` 相当）の初回版に当たる。
**手動 E2E チェックリスト（verification.md 6 章）を通しで実施していないため、本記録では「MVP 完了」とは判定しない。**

## 1. 結果サマリ（V-01〜V-20）

| 検証項目 | 結果 | 実施内容と証跡 | 未実施範囲（手動手順） |
|----------|------|----------------|------------------------|
| V-01 D&D 登録と再起動後の保持 | 部分実施 | 永続化と復元は単体テストで成功（`tests/project-store.test.ts`、evidence/test.log）。登録済みプロジェクトが起動時にタイル表示されることを実アプリで確認（evidence/app-real-project.png） | 実マウス操作での D&D は 6 章 #2・#12 の手動枠 |
| V-02 hooks 追記と既存設定の保全 | 成功 | 単体テスト（.claude なし／既存 hooks あり／不正 JSON／冪等・`tests/hooks-manager.test.ts`）全 green。さらに実アプリ起動経由でサンドボックスの settings.json へマージし、既存 hooks 保全・バックアップ生成・2 回目起動での無書き込みを確認（evidence/sandbox-settings-before.json → after-merge.json、idempotency-check.log） | D&D 起点での一連操作は 6 章 #3 の手動枠 |
| V-03 登録解除で自アプリ分のみ除去 | 成功 | 単体テストで自アプリ分のみ除去・deep equal 一致・空キー削除・不正 JSON 中断を確認（`tests/hooks-manager.test.ts`、evidence/test.log） | 設定画面からの解除操作は 6 章 #16 の手動枠 |
| V-04 Stop 発火 → 1 秒以内に「完了」 | 部分実施 | 擬似注入（curl 実 POST）で Stop → 完了遷移を確認。受信→描画のログ差分 `ui-latency` = **11〜18ms ≤ 1000ms**（evidence/injection-results.log。計測方式は 2026-07-11 変更後の verification.md 3.2 手順 4） | 実 Claude Code セッションでの Stop 発火は 3.2 の手動枠 |
| V-05 Notification 発火 → 「確認待ち」 | 部分実施 | 擬似注入（message = permission 系）で確認待ち遷移・種別分類ログを確認（evidence/injection-results.log、app-demo-injected.png の配送追跡-app） | 実セッションでの許可要求・60 秒放置は 3.3 の手動枠 |
| V-06 呼吸発光（緑/アンバー）と静的な赤 | 部分実施 | CSS 実装は `breath 2.4s ease-in-out infinite`（完了・確認待ちのみ）、エラーは `animation: none`。スクリーンショットで緑/アンバーの発光とエラーの赤を確認（evidence/app-demo-dark.png ほか） | 「約 2.4 秒周期の呼吸」の動的な見え方は 6 章 #6 の目視枠 |
| V-07 実行中表示（スピナー・無発光） | 成功 | 実行中タイルがニュートラル＋スピナー＋経過時間（0:48:14 等）・発光なしで表示（evidence/app-demo-dark.png） | — |
| V-08 タイル表示要素の網羅 | 成功 | プロジェクト名／状態アイコン（✓ ? ⚠ スピナー）／状態ラベル＋相対時刻（完了・2分前）／経過時間（実行中）を確認（evidence/app-demo-dark.png、app-demo-16tiles.png） | — |
| V-09 クリックで前面化（最小化復元含む） | 部分実施 | koffi/user32 FFI のロード・可視トップレベルウィンドウ 38 件の列挙（実 Cursor ウィンドウ含む）・対象不一致時の「ウィンドウが見つかりません」応答を確認（evidence/win32-smoke.log） | 実 Cursor/ターミナルの前面化・最小化復元は 6 章 #8・#9 の手動枠（OS フォーカス依存のため自動化対象外 — verification.md 5 章） |
| V-10 Cursor/ターミナル切替の反映 | 部分実施 | 設定 UI の 2 択トグル実装（evidence/app-settings-dark.png）と clickTarget 永続化の単体テスト成功 | 切替後クリックの実機反映は 6 章 #10 の手動枠 |
| V-11 常に手前の ON/OFF | 部分実施 | `setAlwaysOnTop` ON/OFF の API 反映をログで確認（evidence/run-real-project.log の pin-check 行）。ピン留めボタン・起動時既定値の実装済み | 他ウィンドウとの重なり目視は 6 章 #11 の手動枠 |
| V-12 空状態表示 | 成功 | 登録 0 件で D&D 誘導文言＋「0 セッション」を表示（evidence/app-empty-dark.png） | — |
| V-13 ステータスバー件数の追随 | 成功 | 擬似注入の前後で「8実行中 2完了 1確認待ち 1エラー / 12セッション」→「5実行中 3完了 2確認待ち 2エラー / 12セッション」へ追随（evidence/app-demo-dark.png → app-demo-injected.png）。件数ロジックの単体テストも green | — |
| V-14 アプリ未起動でも Claude Code が完走 | 部分実施 | 停止状態で design.md 4.1 と同一の hook コマンドを実行: exit 28（exit 2 ではない = 非ブロック）・所要 約 2 秒（アーカイブ evidence/hook-noapp.log）。**実測所見: 本マシンでは接続拒否の即時失敗ではなく `-m 2` 上限のタイムアウト失敗**。**追記（2026-07-11 OPEN-04 採用ループ）**: `--connect-timeout 1` で約 1.0 秒／`--connect-timeout 0.5` で約 0.52 秒に短縮できることを実測（各 3 回・いずれも exit 28。evidence/hook-noapp-timeout.log）。採否は design.md 4.6 に記録（今回は未採用・短縮候補として記録） | 実セッションの完走・体感遅延は 3.6 の手動枠 |
| V-15 16 タイルでレイアウト非破綻 | 成功 | 16 タイル（待機タイル含む）で折返し表示・全タイル視認可能（evidence/app-demo-16tiles.png） | クリック可能性の実操作確認は目視枠 |
| V-16 エラーイベントで静的赤表示 | 成功 | design.md 4.8 で形式を確定後、`SessionEnd + reason:"other"` の擬似注入でエラータイル（静的赤・⚠）を確認（evidence/app-demo-injected.png の問い合わせbot、injection-results.log）。マッピングの単体テストも green。検知の網羅範囲は OPEN-03 のまま（9 章） | — |
| V-17 テーマ切替（should） | 成功 | ダーク/ライトのトークン切替を実装。ライト版メイン・設定のスクリーンショット（evidence/app-demo-light.png、app-settings-light.png）。自動はメディアクエリ追従 | モック 1e・1f との詳細比較は目視枠 |
| V-18 MVP で通知音が無効・無音 | 成功 | 通知音トグルが操作不可＋「次期対応」注記で表示（evidence/app-settings-dark.png）。コードベースに音声再生処理は存在せず、config の `notifySound.enabled` は読み込み時に強制 false（単体テストあり） | — |
| V-19 受信サーバが 127.0.0.1 のみバインド | 成功 | `netstat -ano` で `127.0.0.1:41321 LISTENING` のみ・`0.0.0.0` なし（evidence/injection-results.log）。テストでも bind アドレスを assert | — |
| V-20 アイドル時 CPU 負荷 | 成功（短縮版） | **実測（2026-07-11 OPEN-04 採用ループ）**: 「完了」タイル 1 枚（呼吸発光アニメーションあり・スピナーなし）の状態で 60 秒間（2 秒×30 サンプル、`Get-Counter \Process(electron*)\% Processor Time` を論理プロセッサ数 28 で正規化）: **平均 0.03% / 最大 0.359% < 1%**（NFR-07 合格。evidence/idle-cpu.log、計測スクリプト evidence/v20-idle-cpu.ps1） | 3.8 の原手順（5 分放置・タスクマネージャー目視）はさらに長時間の確認をする場合の手動枠 |

## 2. 擬似イベント注入の詳細（verification.md 3.4 / 3.7 の実行結果）

`node scripts/verify-injection.mjs <出力先>` で再実行可能。今回の結果（evidence/injection-results.log）:

| 注入 | 期待 | 結果 |
|------|------|------|
| Stop（棚卸し-app） | 204・実行中→完了 | 204・完了へ遷移（ui-latency 11ms） |
| Notification permission（配送追跡-app のサブディレクトリ cwd） | 204・→確認待ち（親プロジェクトへ対応付け） | 204・確認待ちへ遷移（種別=permission） |
| SessionEnd reason=other（問い合わせbot） | 204・→エラー | 204・エラーへ遷移 |
| 不正 JSON | 400・状態不変 | 400・破棄 |
| 未登録 cwd | 204 受理・破棄ログのみ | 204・「event 破棄」ログ |
| 未知イベント名 | 400 | 400 |
| 別パス /other | 404 | 404 |
| GET | 405 | 405 |

## 3. 自動テスト（verification.md 5 章の単体・統合枠）

- `npm test`（Vitest）: **4 ファイル 57 テスト全件 green**（evidence/test.log）
  - `tests/hooks-manager.test.ts` — settings.json マージ/除去（V-02 / V-03 / NFR-03）
  - `tests/state-store.test.ts` — スキーマ検証・状態遷移 T-1〜T-7・T-10・cwd 最長一致（design.md 4.3〜4.8 / 5 章）
  - `tests/event-server.test.ts` — HTTP 受信・不正入力破棄・バインド（3.4 / NFR-04）
  - `tests/project-store.test.ts` — projects.json / config.json 永続化（V-01 / design.md 9 章）
- `npm run build` / `npm run typecheck` / `npm run lint`: いずれも exit 0（evidence/build.log / typecheck.log / lint.log）

## 4. 未確定事項の技術検証タスク（verification.md 9 章）の状況

| ID | 状況 |
|----|------|
| OPEN-01 | **完了**: Electron で確定（2026-07-11 ユーザー選択）。PoC 比較は不要になった |
| OPEN-03 | 未実施（実 claude プロセスの強制終了実測が必要）。受信側の形式は design.md 4.8 で暫定確定済みのため、検証で SessionEnd hook 追記を採用する場合の受け口は実装済み |
| OPEN-04 | **完了（2026-07-11 案 A 採用・解消）**: ユーザー実測フィードバック（返信＝Stop では変わるが、プロンプト送信では何も変わらない）を受けて案 A を採用。hooks 断片へ UserPromptSubmit を追加し、既存登録へは起動時追補で適用（design.md 4.1 / 4.2 / 4.5）。擬似注入・追補の実測は 6 章。実 Claude Code セッションでの発火タイミング実測は手動枠として残る。T-9 は検証対象になった |

## 5. 次回（手動検証）に残る項目

verification.md 6 章のチェックリストを通しで実施する（特に #2, #4, #5, #8〜#12, #15, #16）。
上表の「部分実施」の未実施範囲はすべて 6 章の該当番号に対応付けてある。

## 6. 追記: OPEN-04 採用ループの実測（2026-07-11。証跡 = `.loop/current/turns/turn-000-evidence/`）

対象変更: hooks 断片の 3 イベント化（UserPromptSubmit 追加）／起動時追補／マーカー厳格化
（command の `/terminal-app/event` 一致）／counts の Snapshot 一本化／表示純関数の切り出し。

### 6.1 UserPromptSubmit → 「実行中」の擬似注入（`node scripts/verify-injection.mjs`）

- デモ 12 タイルへ curl 実 POST（stdin 転送）。`UserPromptSubmit`（在庫管理-app: 完了→実行中）は
  **204 受理 → running 遷移 → ui-latency 9ms**（evidence/injection-results.log）。
- スクリーンショット: 在庫管理-app がニュートラル＋スピナー＋経過時間 `0:00:06` の実行中表示
  （evidence/app-demo-injected.png。ダーク）。ライトテーマの実行中表示は
  evidence/app-demo-light-running.png（棚卸し-app `2:15:11` ほか）。
- 既存注入（Stop 204 / Notification 204 / SessionEnd=error 204 / 不正 JSON 400 / 未登録 cwd 204 破棄 /
  未知イベント 400 / 別パス 404 / GET 405）はすべて前回と同結果（リグレッションなし）。
- V-19 再確認: `netstat` で LISTEN は `127.0.0.1:41321` のみ（同ログ）。

### 6.2 起動時追補（旧 2 イベント → 3 イベント）の before/after（`node scripts/verify-upgrade.mjs`）

旧 2 イベント構成＋他者 hook（command に `terminal-app` をパスとして含む）＋他キー
（permissions / model）を持つサンドボックス settings.json に対し、実モード起動（一時データ
ディレクトリ使用・実 %APPDATA% 非接触）の起動時追補を実測（evidence/upgrade-results.log、
before/after 原本 = evidence/upgrade-before.settings.json / upgrade-after.settings.json）:

- Stop 既設エントリ（他者 hook 含む）無変更: **true** ／ Notification 既設エントリ無変更: **true**
- 他キー（permissions / model）無変更: **true**
- UserPromptSubmit が 1 件だけ追記（マーカー = `/terminal-app/event`）: **true**
- 追補後に UserPromptSubmit を注入: 204 → running（ui-latency 3ms）。タイルが「実行中」
  （スピナー＋経過時間 0:00:06）になったスクリーンショット = evidence/app-upgrade-running.png

### 6.3 V-20 アイドル CPU（短縮版）／ V-14 --connect-timeout

- V-20: 「完了」タイル 1 枚（呼吸発光のみ）で 60 秒サンプリング → **平均 0.03% / 最大 0.359% < 1%**
  （evidence/idle-cpu.log。1 章の V-20 行参照）
- V-14: baseline 約 2.0 秒 / `--connect-timeout 1` 約 1.0 秒 / `--connect-timeout 0.5` 約 0.52 秒
  （いずれも exit 28 ≠ 2 = 非ブロック。evidence/hook-noapp-timeout.log。採否は design.md 4.6）

### 6.4 自動テスト（今回追加分を含む全件）

- `npm test`: **7 ファイル 89 テスト全件 green**（evidence/test.log）。追加分:
  `tests/hooks-manager-open04.test.ts`（3 イベントのマージ/除去・旧 2 イベントからの追補・
  マーカー厳格化での他者エントリ非破壊）／`tests/state-store-open04.test.ts`
  （UserPromptSubmit→実行中を全 5 状態から検証＋HTTP 擬似注入統合）／`tests/format.test.ts`
  （fmtElapsed・fmtRelative・fmtStatusCounts の境界値）
- `npm run build` / `npm run typecheck` / `npm run lint`: いずれも exit 0
  （evidence/build.log / typecheck.log / lint.log）

### 6.5 実 Claude Code セッションでの残作業（手動枠）

実セッションでプロンプトを送信し、UserPromptSubmit hook の実発火 → タイルが「実行中」へ
変わることを確認する（verification.md 3.2 / 3.3 と同枠。擬似注入では受信経路のみ検証済み）。
**→ 7 章（2026-07-11 フォローアップ）で解消。**

## 7. 追記: 手動枠の実測化と実セッション実発火の確認（2026-07-11 フォローアップ。証跡 = `docs/evidence/20260711-followup/`）

これまで「実 Claude Code セッション・実ウィンドウが必要」として手動枠に残していた項目を、
実 claude プロセス（ヘッドレス `claude -p`）と実ウィンドウを使った自動検証で実測した。
あわせて回帰テストを 8 件追加し（tests/ の既存ファイルは無改変）、実装バグ 3 件を発見・修正した
（bug-audit.md 4 章 #14〜#16）。

### 7.1 実セッションの実発火（V-04 / V-05 / OPEN-04 の実測 — 6 章 #4・#5 の解消）

3 経路すべてで「実 Claude Code セッション → hooks 実発火 → 受信 → タイル遷移」を実測した:

1. **本開発セッション自身（対話モード）** — この検証作業を行っている Claude Code セッション
   （project p-43d5, session e7707b33-…）の UserPromptSubmit / Stop / Notification が、
   実稼働アプリ（ポート 41321）に実受信されている（evidence/real-app-log-excerpt.log (1)。
   プロンプト送信 13:42 → running、応答完了 13:55 → done 等）。
2. **信頼済みディレクトリでのヘッドレス実行** — 本リポジトリ直下で `claude -p` を実行し、
   実稼働アプリが UserPromptSubmit → running（14:26:11）・Stop → done（14:26:15）を実受信
   （session 474e89e3-…。同ログ (2)）。
3. **サンドボックス通し検証（`node scripts/verify-real-session.mjs` — 10/10 PASS）** — 一時プロジェクト＋専用
   ポート 41999 で、起動時追補 → 実 claude -p → UserPromptSubmit → running（ui-latency 4ms）→
   Stop → done（ui-latency 9ms）→ 完了タイルのスクリーンショットまで通しで自動実測
   （evidence/real-session-results.log、app-real-session-done.png）。**NFR-01（1 秒以内）を実発火で確認。**

### 7.2 V-09 前面化・最小化復元の実測（6 章 #8・#9 の解消）

`node scripts/verify-foreground.mjs`（evidence/foreground-results.log）: 実ターミナルウィンドウ
（windowsterminal.exe）を新規に開き、アプリ本体の `focusProjectWindow` で **7/7 PASS** —
(1) 前面化成功＋GetForegroundWindow 一致（#8）、(2) SW_MINIMIZE → IsIconic=true から復元＋前面化
（#9）、(3) 不一致対象は ok=false（例外なし）。
補助証跡: 実稼働アプリでのユーザー実クリックによる「前面化 成功」ログ多数（real-app-log-excerpt.log (3)。
clickTarget=cursor での実運用 = #10 の実運用面も裏付け）。

### 7.3 再起動後の登録保持（6 章 #12 / T-10）と V-14

- verify-real-session の Phase 3: 再起動後も projects.json の登録が保持され（V-01 後半）、
  セッション状態は持ち越されない（受信 0 件 = 全タイル「待機」。T-10）。スクリーンショット =
  evidence/app-real-restart-waiting.png
- Phase 4（V-14）: アプリ未起動で (a) 整備済み実 hook コマンドは `curl -m 2` により短時間で
  打ち切られ非ブロック（exit 28 ≠ 2）、(b) 実 `claude -p` セッションも exit 0 で完走
  （アプリ稼働中と同等の所要時間）。

### 7.4 追加した回帰テスト（bug-audit #1 / #6 の直接カバー）

`npm test`: **9 ファイル / 97 テスト全件 green**（+8 件。tests/ の既存ファイル無改変）

- `tests/event-server-multibyte.test.ts` — TCP チャンクがマルチバイト文字（3 バイト日本語・
  4 バイト絵文字）の途中で割れても原文一致・U+FFFD 不在。上限超過（413）は onEvent へ届かない
- `tests/state-store-remove.test.ts` — removeProjectSessions の対象限定除去・件数追随・
  changed 発火条件・再登録シナリオ

### 7.5 フォローアップで発見・修正した実装バグ（bug-audit.md 4 章）

| # | 内容 | 検出経緯 |
|---|------|----------|
| 14 | config.json の `port` 変更が受信サーバに反映されない（トップレベルで既定ポートを捕捉） | 専用ポートのサンドボックス検証で hooks 送信先と listen が食い違い発覚 |
| 15 | 受信ポート使用中のエラーダイアログがウィンドウ生成前に出てメインプロセスを塞ぐ（「UI は起動継続」にならない） | #14 との複合で無人検証がハング |
| 16 | TERMINAL_APP_DATA_DIR 指定時も Electron userData（Chromium プロファイル）が実稼働と共有され並走時に競合 | 実稼働アプリと検証の並走で顕在化 |

修正後、`npm test`（97 件）/ typecheck / lint / build すべて exit 0。

### 7.6 手動枠に残る項目

- 6 章 #2（実マウスでの D&D 登録）・#6（呼吸発光の動的な見え方の目視）・#13（テーマのモック比較目視）
- OPEN-03（claude プロセス強制終了時の発火実測）は引き続き未実施（受け口は実装済み）

## 8. 追記: 260907_1 作業中の完了・切断誤判定の防止（V-22。証跡 = `docs/evidence/20260907-loop-running/`）

### 8.1 背景の実測（2026-09-07 03:00〜03:35 JST。実稼働アプリの app.log と `~/.claude/sessions` の突合）

- Monthly-report の品質ループ: 03:06 UserPromptSubmit → 実行中、03:12 generator の同期 fork 開始で本体 transcript の更新が停止、
  03:27:31 と 03:28:16 に「切断検知」。その間、登録簿 status は busy のまま、fork の記録
  `<sessionId>/subagents/agent-a9ea20283d12c6e54.jsonl` は 03:32 時点でも更新が続いていた（= 誤判定）。
- 登録簿 status の切替: Stop と同じ秒に idle（product-register 00:13:16 / rakuten 00:27:34）、Esc 割り込みでも即 idle
  （pad-python 22:58:08。終了検知より 14 秒早い）、権限確認は Notification より数秒早く waiting。
- block された Stop の痕跡: 対話 transcript の `system{stop_hook_summary}` に `preventedContinuation` フィールドがある
  （通常の Stop は false）。`claude -p` の transcript には summary 自体が書かれない。

### 8.2 自動テスト（TDD。先に RED を確認）

- 新規 4 ファイル 49 件（`tests/session-scan-blocked-stop.test.ts` 18 件 / `tests/liveness-monitor-stopped-resume.test.ts` 20 件 /
  `tests/state-store-stopped-resume.test.ts` 8 件 / `tests/session-registry-env.test.ts` 3 件）。実装前: 42 件 FAIL / 7 件 PASS（既存挙動）→ 実装後: 全件 PASS。
- `npm test`: **50 ファイル / 443 テスト全件 green**（既存テスト無改変）。`npm run typecheck` / `npm run lint` / `npm run build` すべて exit 0。

### 8.3 E2E（`node scripts/verify-loop-running-e2e.mjs docs/evidence/20260907-loop-running`。24 項目すべて OK）

専用ポート 42199・一時 dataDir・擬似登録簿（`TERMINAL_APP_SESSIONS_DIR`。pid は検証スクリプト自身）・掃引 2 秒・切断閾値 20 秒。

| シナリオ | 結果 | 証跡 |
|----------|------|------|
| (a) 登録簿 busy のまま Stop → 0.5 秒後は「完了」→ 4.5 秒後に「実行中」へ戻る（ログ「完了から実行中へ復帰 … 登録簿 status=busy」） | OK | `01-cli-resumed-from-done.png` / app.log 18:58:59〜18:59:03Z |
| (a) 登録簿 idle にして Stop → 6.5 秒後も「完了」のまま | OK | app.log 18:59:04Z 以降に復帰なし |
| (b) status 無し（Cursor 相当）で Stop → transcript に block 痕跡を追記 → 「実行中」＋作業テキスト `[Eval-loop iteration 1/4 \| RESUME 1/3]` | OK | `02-vscode-resumed-by-blocked-stop.png` / app.log 18:59:15Z |
| (b) 正常終端（summary false ＋ turn_duration）を追記して Stop → 「完了」のまま | OK | app.log 18:59:16Z 以降に復帰なし |
| (c) 本体 transcript を 60 秒前にしても登録簿 busy なら切断しない | OK | 5 秒後も running |
| (c) status 無しでも subagent 記録が新しければ切断しない | OK | 5 秒後も running |
| (c) 本体・subagent とも古いと切断 → subagent 記録の追記で「実行中」へ戻る | OK | `03-vscode-disconnected.png` / `04-vscode-resumed-from-disconnected.png` / app.log 18:59:35Z 切断 → 18:59:39Z 復帰 |

初回実行は切断閾値を 4 秒にしていたため (b)(c) の待ち時間中に誤切断して 3 件 NG になった（アプリ側の判定は正しく動作。
ログに復帰の記録あり）。閾値を 20 秒にし、切断させたい場面では mtime を 60 秒前に設定する方式へ修正して全件 OK。

### 8.4 稼働アプリへの反映

- 旧プロセス（PID 89908）を `taskkill //PID` で終了（19:00:05Z「terminal-app 終了」）→ 新ビルドを起動（19:00:29Z「terminal-app 起動」、PID 100028）。
- 再起動でセッション表示は揮発するため、実ループでの復帰は次の Stop / 切断以降のログで確認する（本作業時点では未観測）。

### 8.5 手動枠に残る項目

- 実ループ（対話セッション）で block された Stop の transcript 形状（`preventedContinuation:true` の実物）は本機にまだ無く、
  フィールド定義と E2E の擬似レコードで確認した。実物が出たら `classifyTurnEnd` の分類を再確認する。

### 8.6 追記: 260907_2 ループ進捗バッジ（V-23。証跡 = `docs/evidence/20260907-loop-badge/`）

- 自動テスト（TDD。先に RED を確認）: 新規 2 ファイル 19 件（`tests/eval-loop-status.test.ts` 16 件 / `tests/state-store-loop-text.test.ts` 3 件）。
  `npm test`: **52 ファイル / 462 テスト全件 green**（既存テスト無改変）。`npm run typecheck` / `npm run lint` / `npm run build` すべて exit 0。
- E2E（`node scripts/verify-loop-badge-e2e.mjs docs/evidence/20260907-loop-badge`。13 項目すべて OK）: 擬似 eval-loop ディレクトリ
  （`TERMINAL_APP_EVAL_LOOP_DIR`）に v3 形式の state.json と codex ジョブ（heartbeat・started_at）を置き、専用インスタンスに実 hook 形式の
  UserPromptSubmit を注入。

| シナリオ | 結果 | 証跡 |
|----------|------|------|
| (a) `registry/sessions/<sessionId>` のループ（2 周目・best_score 78・generator ジョブ走行中）→ 「ループ 2/4・codex 実装中 1分・最高 78点」 | OK | `01-badges.png` / app.log「ループ進捗バッジ 表示」 |
| (b) `registry/agents/<agentId>` の fork ループ（state の session_id で対応付け）→ 「ループ 1/4・採点中」 | OK | `01-badges.png` |
| (c) ループの無いセッションはバッジ無し・行ごと非表示（レイアウト不変） | OK | `01-badges.png` の loop-c |
| (d) heartbeat が 30 秒超で古くなる → 「ループ 2/4・実装中・最高 78点」（codex 表示が消える） | OK | 掃引 1 回で反映 |
| (e) 終了（threshold_met・92 点）→ 「ループ終了・合格 92点」／31 分前に終わった fork ループは消える | OK | `02-ended.png` / app.log「ループ進捗バッジ 消滅」 |

- 回帰: `node scripts/verify-split-blink-e2e.mjs`（260904_1。バッジが名前の下の行にあること等 8 項目）は全件 OK のまま
  （手動バッジをループバッジと同じ `.tile-badge-row` に移しても位置・表示は変わらない）。
- 画像の目視: バッジはアクセント色（青）のピル。長い文言はタイル幅で「…」省略され、hover の title で全文が読める。
- 稼働アプリへの反映: 旧プロセス（PID 100028）を終了 → 新ビルドを起動（19:18:58Z「terminal-app 起動」、PID 33812）。
  実ループの Monthly-report（registry/sessions に state あり）は再起動で表示が揮発するため、次の hook イベント以降にバッジが載る。

### 8.7 追記: 260908_1 作業継続中の保持＋ループ状態の `.mso` 追従（V-23 / V-24。証跡 = `docs/evidence/20260908-held/`）

- 発端（2026-09-08 実測ログ 08:06〜08:28Z、Pricefluctuation-app session=632eda45）: 品質ループの司令塔が codex を Monitor で待つ間、
  `<task-notification>` 起床 → UserPromptSubmit → 短い応答 → Stop／終了検知 が 30 秒〜1 分ごとに繰り返され、そのたびにタイルが「完了」へ倒れ
  完了トーストが出た。60 秒アイドルで入力待ち Notification → 「確認待ち」トースト。登録簿 status は応答後 `shell`（busy ではない）。
  さらに `~/.claude/eval-loop/registry` はプラグイン v0.2 で廃止済み（ディレクトリ自体が無い）ためループバッジが出ていなかった。
- 自動テスト: `tests/eval-loop-status.test.ts` を `.mso` 配置へ書き直し（16 件）、新規 `tests/state-store-held.test.ts`（8 件）・
  `tests/liveness-monitor-held.test.ts`（6 件）。既存の期待値変更は `state-store-confirm-resume`（confirmSessions に `kind` が載る）1 か所。
  `npm test`: **54 ファイル / 475 テスト全件 green**。`npm run typecheck` / `npm run lint` / `npm run build` すべて exit 0。
- E2E（`node scripts/verify-loop-badge-e2e.mjs docs/evidence/20260908-held`。31 項目すべて OK）: 擬似プロジェクト 3 つに `.mso` の state と進捗ログ、
  擬似登録簿（a=idle / b=busy / c=shell）を置き、専用インスタンスへ実 hook 形式のイベントを注入。

| シナリオ | 結果 | 証跡 |
|----------|------|------|
| (a) `.mso/sessions/<sid>/state.json`（2 周目・best 78・generator 進捗ログ走行中）→ 「ループ 2/4・codex 実装中 0分・最高 78点」＋「作業継続中として保持」ログ | OK | `01-badges.png` / app.log |
| (b) `.mso/agents/<agentId>/state.json`（fork。session_id で対応付け）→ 「ループ 1/4・採点中」 | OK | `01-badges.png` |
| (c) ループ無し → バッジ無し | OK | `01-badges.png` |
| (f) ループ進行中の Stop（登録簿 idle）→ 実行中のまま（3.5 秒後の前倒し判定を跨いでも）／入力待ち Notification → 確認待ちにならない／許可要求 → 確認待ちで掃引でも戻らない | OK | `02-held.png` / app.log「event 受信: Stop → running（実行中を維持: ループ進行中（…））」 |
| (d) 進捗ログに PHASE_END → 「ループ 2/4・実装中・最高 78点」 | OK | 掃引 1 回で反映 |
| (e) 終了（threshold_met・92 点。ended_at 無し → mtime）→ 「ループ終了・合格 92点」／31 分前に終わった fork は消える／終了後の Stop → 完了 | OK | `03-ended.png` |
| (g) `<task-notification>` で起床 → 作業テキスト維持／Stop でも登録簿 `shell` の間は実行中／`idle` にしたら掃引の終了検知で完了（「保持を解除」「終了検知」） | OK | `04-released.png` / app.log |

- 手動枠: 実ループでのトースト（保持中は出ず、ループ終了の Stop 後に「ループ終了・合格 NN点」付きで 1 回）は Windows 通知のため CDP では検証できない。
  稼働アプリの `app.log` で「実行中を維持」「保持を解除 → 完了」を確認する。

### 8.8 追記: 260908_2 残骸 state の無視・通知種別の公式化（V-23 / V-24。証跡 = `docs/evidence/20260909-remnant/`）

- 発端（2026-09-09 10:39 ユーザー報告・実測）: Pricefluctuation-app のループは 2026-09-08 19:06 に threshold_met で終わっているのに、
  タイルは「ループ 1/12・計画中（他 2 本）」で実行中のまま（0:14:56）。`.mso/agents/` に `active=true` / `task=""` / `iteration 0/12` の
  事前作成 state が 3 つ残り、保持の根拠になっていた。プラグインの never_started GC を手動で実行すると閉じる（hook は 0.2.2 と同一内容）が、
  稼働セッションでは効いていなかった（原因は未特定。プラグイン側の課題として記録）。
- 参考（firecrawl 検索 3 件・公式 hooks reference の scrape）: Notification hook は `notification_type`（permission_prompt / idle_prompt /
  elicitation_dialog / elicitation_url_dialog / agent_needs_input / agent_completed / quota_auto_resume_* 等）を持つ。SubagentStart / SubagentStop は
  Task 起動で確実には発火しない（anthropics/claude-code#27755）。Stop は `stop_hook_active` / `last_assistant_message` を持つ（transcript は遅延しうる）。
- 自動テスト: `tests/eval-loop-status.test.ts` に残骸の無視 2 件、`tests/state-store-held.test.ts` に notification_type の分類 3 件を追加。
  `npm test`: **54 ファイル / 480 テスト全件 green**。`npm run typecheck` / `npm run lint` / `npm run build` すべて exit 0。
- E2E（`node scripts/verify-loop-badge-e2e.mjs docs/evidence/20260909-remnant`。35 項目すべて OK）: (h) セッション c に task="" の残骸 state を
  3 つ置いてもバッジ無し・Stop で完了（保持されない）。(f) `notification_type: idle_prompt` は文言が permission 風でも保持、`agent_needs_input` は確認待ち。
  ログに「種別=idle(idle_prompt)」を併記。既存 (a)〜(g) は全件 OK のまま（本物のループ state には task を書くようにした）。
- 稼働アプリ: 手動 GC の直後の掃引（01:44:44Z）で「保持を解除 → 終了検知 → 完了」を確認。新ビルドで再起動。

### 8.9 追記: 260909_1 入力待ちの誤「切断」防止・SessionStart（V-24。証跡 = 単体テスト・実ログ）

- 発端（2026-09-09 12:38 ユーザー報告）: instagram-app のタイルが「切断・8 分前」のまま。実ログ: 03:08:50Z idle_prompt → 確認待ち、
  03:14:46Z「確認待ちから復帰 — 許可後に transcript が更新」（実体はユーザーの `/effort` `/model`。transcript に user レコード 3 件）、
  03:30:01Z「切断検知 — transcript 更新途絶」（登録簿は idle・プロセス生存）。03:37:47Z に本当に終了（再起動）し新セッションが始まったが、
  新セッションは最初のプロンプトまでイベントが無く、前セッションの「切断」が残った。
- 自動テスト: 新規 `tests/liveness-monitor-idle.test.ts`（終端分類のローカルコマンド読み飛ばし・confirm 復帰の open 要件・findIdleConcluded・
  切断判定の idle 除外）6 件、`tests/state-store-session-start.test.ts` 4 件。既存の期待値変更 2 か所（idle は切断しない）。
  `npm test`: **56 ファイル / 490 テスト全件 green**。`npm run typecheck` / `npm run lint` / `npm run build` すべて exit 0。
- E2E 回帰: `node scripts/verify-loop-badge-e2e.mjs docs/evidence/20260909-remnant` 35 項目すべて OK のまま。
- 稼働アプリ: 新ビルドで再起動。起動時追補で登録済み全プロジェクトの `.claude/settings.json` に SessionStart が追記される（ログ「起動時追補」）。
  SessionStart は新しい Claude Code セッションから発火する（既存セッションには効かない）。

# 引き継ぎ資料（Codex 向け）— 2026-09-28

terminal-app の作業を Codex に引き継ぐための資料。**最初にやること**と**残っている課題 3 件**を先に書く。
アプリの全体像は `README.md`、要件は `docs/spec.md`（REQ / AC）、設計は `docs/design.md` が正本。

---

## 0. 最初にやること

```
npm install          # 初回のみ
npm run build
npm run diagnose     # 直近の動作を 13 項目で確認（NG があれば終了コード 1）
```

`npm run diagnose` は 2026-09-27 に追加した自己診断。受信サーバ・hooks・Jev・claude CLI・登録簿・
直近ログ・表示と実データの整合を一度に見る。**課題 1 と 2 はこのコマンドで再現・確認できる**。

アプリの起動は `start-app.bat`、または
`node_modules\electron\dist\electron.exe .`（CDP で覗くなら `--remote-debugging-port=9333`）。
**ビルド後は再起動しないと反映されない。** 再起動するとタイルの表示は `sessions.json` から復元される。

現在の HEAD は `8764e6d`、テストは **623 件すべて green**（`npx vitest run`）、
`npm run typecheck` と `npm run lint` も通る。作業ツリーはクリーン（`.mso/` は追跡対象外の作業用）。

---

## 1. 残っている課題

### 課題 1（優先度 高）確認待ちが 15 秒で「完了」に落ちる — 状態の往復

**症状**: `npm run diagnose` が `NG 状態の往復: 35 回`（直近 6 時間。5 日分では 109 回）を出す。
同じセッションで `確認待ちから復帰 → 終了検知` が**同じ掃引（同じ秒）**で繰り返されている。

```
19:02:22 [INFO] 確認待ちから復帰: X (session=...) — 許可後に transcript が更新
19:02:22 [INFO] 終了検知: X (session=...) — Stop 未受信だが transcript がターン完了を示すため「完了」へ
```

**影響**: ユーザーが見たい「確認待ち」の表示が 15 秒で消える。往復のたびに Jev の返答待ち判定が走る
（直近 6 時間で 60 回）。ログが往復で埋まる。

**原因の見立て**: `liveness-monitor.findResumedFromConfirm`（260904_1）の復帰条件が緩い。
`transcript の mtime >= 確認待ちイベント時刻 + CONFIRM_RESUME_MARGIN_MS(3s)` だけで「作業再開」と見なすため、
入力待ち中に書かれるメタレコード（`ai-title` / `last-prompt` / `atis-latch` など）でも復帰してしまう。
復帰 →「実行中」→ 同じ掃引の `findConcluded` が `turnEnd=concluded` を見て「完了」へ、の往復になる。

**修正案**: 返答待ち（`confirmKind="question"`）で既に採った方針と同じにする。
`findResumedFromQuestion`（260922_4）は mtime ではなく**終端分類**で見ており、往復していない。
つまり確認待ちの復帰も「`turnEnd === "open"`（ターンが実際に再開）」または「登録簿 status=busy」
に寄せるのが筋。`CONFIRM_RESUME_MARGIN_MS` の延長は対症療法なので勧めない。

**注意**: この領域は PR #1（後述）も触っている。**PR の扱いを決めてから直す**こと。二重修正になりやすい。

**テストの当て方**: `tests/liveness-monitor-*.test.ts` に純関数のテストがある
（`findResumedFromConfirm` は `tests/state-store-confirm-resume.test.ts` と合わせて確認）。
往復の検出そのものは `tests/diagnose.test.ts` の `analyzeAppLog` で再現済み。

### 課題 2（優先度 中）Jev のタイムアウトが出ている

**症状**: `WARN 警告・エラー` に `Jev: タイムアウト（4000ms。判定なしとして続行）` が直近 24 時間で数件。

**影響**: その回の判定が落ちるだけで表示は壊れない（失敗は常に「判定なし」に倒す設計）。
ただし返答待ちの検出漏れになる。

**見立てと案**: `jev-client.ts` の `DEFAULT_JEV_TIMEOUT_MS = 4000`。日本からの実測は 200〜650ms なので
4 秒で切れるのは異常系（ネットワークの一時的な詰まり）。1 回だけ再試行するか、タイムアウトを 8 秒に伸ばす。
判定は非同期で表示を止めないので、伸ばしても体感は変わらない。

### 課題 3（優先度 中）PR #1 の取り込み方を決める

`https://github.com/kurocoma/terminal-app/pull/1`（Travel-Connect、2026-09-09、+3278 / -506、37 ファイル）。
分岐元が `b70e32d` で、そこから main は 15 コミット進んでいるため**コンフリクトしている**
（`src/main/index.ts` / `liveness-monitor.ts` / `state-store.ts` / `completion-dashboard.html`）。

- **重複している部分**: PR の「作業継続中の保持（`heldReasonFor`）」は、main 側の
  260907_1（登録簿 busy・block 痕跡）と 260922_8（subagent 記録・Jev の委譲判定）とねらいが同じ。
  実装は別物なので、どちらかに寄せる必要がある。main 側の方が新しく、テストと実測の証跡がある。
- **PR にしかない価値（取り込む候補）**:
  1. **通知種別を公式の `notification_type` で判定**。main は `classifyNotification` がメッセージ文字列を
     見ている（`permission` / `許可` の部分一致）。公式フィールドの方が確実で、危険度判定を
     権限確認のときだけ走らせる条件（`index.ts`）にも効く。
  2. **残骸 state.json の無視**（task 未設定のループ状態をループ進行中と誤認しない）。
  3. **`SessionStart` の後始末**（新しいセッション開始時に前セッションの表示を消す）。main には無い。
- **推奨**: まるごとマージせず、上の 3 点を main の設計に合わせて移植する。特に 1 は課題 1 とも関係する。

---

## 2. このアプリは何か（30 秒で）

Claude Code の並行セッションを監視する Windows の常駐タイルダッシュボード（Electron）。
各プロジェクトのフォルダを登録すると、そのフォルダの `.claude/settings.json` に hooks が自動追記され、
Stop / Notification / UserPromptSubmit などのイベントが `http://127.0.0.1:41321/terminal-app/event` に届く。
タイルは「待機 / 実行中 / 完了 / 確認待ち / エラー / 切断」を色と発光で示し、クリックで対象ウィンドウを前面化する。

状態の判定材料は 4 つ。**どれも「事実」であって推測ではない**。

| 材料 | 何が分かるか | 読む場所 |
|---|---|---|
| hooks イベント | 開始・終了・確認待ち | 受信サーバ（`event-server.ts`） |
| transcript | ターンが終わったか・最後の返答・直近の手順・タスク名 | `~/.claude/projects/<munge>/<sessionId>.jsonl` |
| 登録簿 | プロセスの生死・busy / idle | `~/.claude/sessions/<pid>.json` |
| subagent 記録 | 裏でエージェントが動いているか | `<transcript のベース名>/subagents/agent-*.jsonl` |

---

## 3. 直近 2 日で入れたもの（2026-09-22〜27）

| 版 | 内容 | 主なファイル |
|---|---|---|
| 260922_1 | 確認待ちのタイルをグリッドの左上へ（表示上だけ。`projects.json` の並びは変えない） | `renderer/format.ts` |
| 260922_2 | **Jev（TypeSafe AI）を 4 判定で導入**（返答待ち・危険度・作業テキストの上書き防止・停滞） | `jev-client.ts` / `jev-judge.ts` |
| 260922_3 | 起動時に生存セッションを transcript から復元し、完了分を返答待ち判定へ | `index.ts` / `session-scan.ts` |
| 260922_4 | 返答待ちにも完了と同じ復帰規則（登録簿 busy・block 痕跡・ターン再開） | `liveness-monitor.ts` |
| 260922_5 | `<task-notification>` などの自動挿入枠を作業テキストに出さない | `state-store.ts` |
| 260922_6 | タイル名と作業の整合を Jev で判定し、Claude Sonnet で改名 | `jev-judge.ts` / `name-suggest.ts` |
| 260922_7 | **再起動しても表示を引き継ぐ**（`sessions.json` に保存し、実データと突き合わせて復元） | `session-snapshot.ts` |
| 260922_8 | サブエージェント待ちを「実行中」に保つ（subagent 記録の mtime ＋ Jev の委譲判定） | `session-scan.ts` / `liveness-monitor.ts` |
| 260922_9 | 表示名の AI 提案の不具合修正（プロンプトは標準入力で渡す・説明文の除去・言い直し） | `name-suggest.ts` |
| 260922_10 | **セッションごとのタスク名表示**（transcript の `ai-title`）と表示名の自動変更 | `session-scan.ts` / `index.ts` |
| 260927_1 | 自己診断 `npm run diagnose` | `diagnose.ts` / `scripts/diagnose.mjs` |

### Jev の使い方（設計の要点）

判定は `jev-judge.ts` に純関数として集約。**質問文は英語、判定対象（state）は日本語のまま**渡す。
1 リクエストに 3〜4 問まとめても応答は 200〜650ms。閾値と実測値は同ファイルのコメントにある。

守っている原則（これを崩すと壊れる）:

1. **事実で取れるものは Jev に聞かない**。subagent の mtime・`ai-title`・登録簿の status・終端分類はファイルを読む。
2. **失敗は常に「判定なし」へ倒す**。キー無し・HTTP エラー・タイムアウト・形式不正のどれでも従来動作。
3. **適用の直前に事実を再確認する**。判定は非同期なので、その間に状況が変わっていたら見送る。
4. **同じ材料では聞き直さない**（メモ化）。怠ると判定 → 状態変更 → 別ルールが戻す、の往復になる（実際に起きた）。
5. **生成は別モデル**。名前を作るのは `claude -p --model sonnet`（`name-suggest.ts`）。Jev は判定専用。

知見の詳細は Obsidian の `30_Atlas/Notes/jev-typesafe-system-one-model.md`（2026-09-22 の追記）にまとめてある。

---

## 4. 作業のルール

- **テストを必ず足す**。純関数として切り出してから `tests/` に書く。現在 623 件。
  `npx vitest run` / `npm run typecheck` / `npm run lint` の 3 つが通ること。
- **コメントと文言は日本語**。「なぜそうするか」と実測の根拠（日付つき）を書く。既存ファイルの書き方に合わせる。
- **実機で確かめたら証跡を残す**。`docs/evidence/<日付>-<名前>/` にスクリーンショットや JSON を置き、
  `docs/verification-results.md` に結果を書く。E2E は `scripts/verify-*-e2e.mjs` が雛形
  （専用 dataDir・専用ポートで実稼働アプリと並走できる）。
- **仕様を変えたら `docs/spec.md`（REQ / AC）と `docs/design.md` を更新する**。README はユーザー向けの説明。
- **コミットは日本語 1 行 + 本文**。末尾に Co-Authored-By を付ける慣習（既存のログを参照）。
- 評価基準（lint / tsconfig / settings）を緩めて通すのは禁止。実装を直す。

---

## 5. 環境の勘所（はまりやすい点）

- **Jev の API キー**: `%USERPROFILE%\.typesafe.env` の `TYPESAFE_API_KEY=...`（環境変数でも可）。
  無くてもアプリは動く（判定が全部スキップされる）。`TERMINAL_APP_JEV=off` で明示的に止められる。
- **claude CLI**: 表示名の提案・自動リネームに使う。**複数行のプロンプトを cmd.exe の引数に渡すと壊れる**
  （改行がコマンド区切りになる）。標準入力から渡すこと。実行は 7〜70 秒かかる。
- **アプリの再起動**: `taskkill /IM electron.exe /F` は他の Electron アプリも巻き込むので注意。
  再起動すると `sessions.json` から表示が復元される（初回は保存が無いので transcript から作り直す）。
- **掃引は 15 秒ごと**（`TERMINAL_APP_LIVENESS_INTERVAL_MS` で短縮できる。E2E はこれを使う）。
- **デモ実行**（`--demo` / `--demo-count=16`）は一時データディレクトリを使い、実設定・実 hooks に触れない。
  Jev も無効になる。UI の見た目を確認するときはこれ。
- **診断の受信サーバ疎通**は架空 session_id と未登録 cwd を使うので、実行しても表示は変わらない。

---

## 6. 参照

- 要件・受入基準: `docs/spec.md`（REQ-01〜27 / AC-01〜31）
- 設計: `docs/design.md`（モジュール分割・状態遷移・判定の根拠）
- 検証手順と記録: `docs/verification.md` / `docs/verification-results.md`
- 直近の完了報告: `completion-dashboard.html`（ブラウザで開く）
- 自己診断の最新結果: `docs/evidence/20260927-diagnose/result.json`
- Jev の知見: Obsidian `30_Atlas/Notes/jev-typesafe-system-one-model.md`

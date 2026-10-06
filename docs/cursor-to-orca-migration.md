# terminal-app: Cursor から Orca への移行記録

クロコマースで移行を依頼するときは、[ワンショット依頼文](kurocommerce-orca-one-shot.md)をそのまま渡す。この資料は、terminal-app の移行実装と別 PC・別リポジトリで再現する条件をまとめたもの。

確認日: 2026-10-05（日本時間）。実装の基準は Travel-Connect/terminal-app の `6e23614525bdd24624c7fd7de4c93d96dad6056b`。クロコマース側の移行実行は今回の作業には含めていない。

## 1. 取得元と、main だけでは足りない理由

| 対象 | 確認した状態 |
|---|---|
| 移行実装の取得元 | [Travel-Connect/terminal-app](https://github.com/Travel-Connect/terminal-app) |
| Orca 対応ブランチ | `fix/cursor-launch-environment` |
| 基準コミット | [6e23614](https://github.com/Travel-Connect/terminal-app/commit/6e23614525bdd24624c7fd7de4c93d96dad6056b)（スリープ対応まで） |
| Travel-Connect の main | `0863e62`。確認時点では Orca 対応を含まない |
| クロコマース側の候補 | [kurocoma/terminal-app](https://github.com/kurocoma/terminal-app)。既存 checkout の remote で移行先を確定する |
| kurocoma の main | `9302b04`。独自の自己診断と引き継ぎ資料があるため保持する |

Orca 対応は [PR #3](https://github.com/Travel-Connect/terminal-app/pull/3) のブランチに入っている。PR #3 の取り込み先は `feat/codex-session-tiles`、その基盤は [PR #2](https://github.com/Travel-Connect/terminal-app/pull/2) から `main` へ取り込む構成。PR の題名だけでは Orca 対応を判断しにくいので、コミットと実装を確認する。

この状態で `git clone` して `main` をビルドしても Orca の選択肢は出ない。移行時は基準コミットを含むコードを取り込む。ブランチ先端は動くため、再現には上記のコミットを使い、後続修正を採用する場合は差分を確認して採用した SHA を記録する。

## 2. 移行の経緯

| 日付 | コミット | 変更と移行への意味 |
|---|---|---|
| 2026-09-25 | [9253f5d](https://github.com/Travel-Connect/terminal-app/commit/9253f5d) | Claude と併せて Codex の状態を表示する基盤 |
| 2026-09-25 | [1213b80](https://github.com/Travel-Connect/terminal-app/commit/1213b80) | terminal-app のログが Codex の入力端末へ混ざる問題を修正 |
| 2026-09-30 | [a50bc39](https://github.com/Travel-Connect/terminal-app/commit/a50bc39) | Cursor 等の起動時に Codex 用の端末環境を持ち出さない。これは `launchProjectApp` の処理で、Orca CLI 全体への補正ではない |
| 2026-10-05 | [19a0f66](https://github.com/Travel-Connect/terminal-app/commit/19a0f66) | 終了した Codex 履歴も、対象ウィンドウがないときは未接続表示 |
| 2026-10-05 | [9540a07](https://github.com/Travel-Connect/terminal-app/commit/9540a07) | Orca クリック先、タブ切替、起動、複数 Codex 保存先、画面プレビュー、返信・中断、差分表示、指示履歴 |
| 2026-10-05 | [6e23614](https://github.com/Travel-Connect/terminal-app/commit/6e23614) | Orca のスリープを専用表示し、切断通知を抑制 |

`9540a07` は Codex 監視の基盤に依存する。古いクロコマース側のコードへ Orca の 2 コミットだけを cherry-pick する手順にはしない。まず履歴の共通祖先と依存コードを確認する。

## 3. 再現する動作

| 操作・状況 | 移行後の動作 |
|---|---|
| 設定の「クリックで開くアプリ（一括）」で Orca を選ぶ | 全登録プロジェクトを切り替え、新規登録の既定も Orca にする |
| 個別のクリック先変更 | そのプロジェクトだけ Cursor / Orca / ターミナルを選べる |
| タイルをクリック | Win32 で Orca の窓を前面化し、CLI で対象セッションのタブへ切り替える |
| 未接続タイルの「立ち上げる」 | 必要なら Orca を起動・フォルダを登録し、そのフォルダのターミナルを作る |
| タイルのホバー | ターミナル画面の末尾と、そのセッションへの最近の指示を表示 |
| 「Orca: 画面を見て返信…」 | 画面を見ながら 1 行で返信。正確な送信先が確認できる場合だけ有効 |
| 「中断（Esc）」 | 対象セッションに Esc を送る |
| 「Orca で変更ファイルを開く（差分）」 | 変更ファイルを Orca の差分タブで表示 |
| Orca 内の Codex が waiting / blocked | 実行中タイルを「確認待ち」に補正 |
| 登録済みフォルダで生きた端末が 0 | 「☾ スリープ中（Orca）」と表示。起こす操作は右クリックの「起こす」 |

「立ち上げる」「起こす」はターミナル作成まで。Claude / Codex 自体を自動で新規起動する機能は追加していない。エージェントの起動と認証は Orca 側で行う。

## 4. 環境と保存先

Windows 11、Node.js 22 以上、npm、Git、`curl.exe`、Orca を用意する。Claude / Codex の利用には本人の認証が必要。Orca の導入元は [公式リポジトリ](https://github.com/stablyai/orca)と[公式リリース](https://github.com/stablyai/orca/releases)を使う。CLI の仕様はインストールした版の `skills get orca-cli --json` と `--help` を優先する。

| 場所 | 用途・取り扱い |
|---|---|
| `%LOCALAPPDATA%\Programs\orca\resources\bin\orca.exe` | Orca 同梱 CLI。terminal-app はここを優先し、次に PATH を探索する |
| `%APPDATA%\terminal-app\projects.json` | 登録パス、表示名、クリック先、並び順など。PC ごとのローカル設定 |
| `%APPDATA%\terminal-app\config.json` | `defaultClickTarget`、ポート、表示設定など |
| `%APPDATA%\orca\agent-hooks\last-status.json` | エージェントのセッション ID とターミナルのペインを対応付ける |
| `CODEX_HOME`、未指定なら `%USERPROFILE%\.codex` | 通常の Codex 保存先 |
| `%APPDATA%\orca\codex-runtime-home\home` | Orca の既定アカウント用 Codex 保存先。通常の保存先と併せて監視する |
| プロジェクトの `.claude/settings.json` | terminal-app の hooks を既存設定にマージする。Orca 自身の hooks と共存する |

移行のために Codex の認証情報、会話 DB、Orca の接続情報を別 PC からコピーする必要はない。クロコマース側ではその PC の認証とパスを使う。`.env.local` はリセット・上書き・削除しない。

通常の登録フォルダと、Orca でエージェントが動く実際の cwd を一致させる。最初は既存 checkout を Orca に登録する方法が確実。Orca が別の worktree を作った場合は、その実パスを terminal-app に別途登録する。元フォルダの登録だけでは別 worktree のセッションを表示できない。

`TERMINAL_APP_DATA_DIR` は検証用の隔離にも使うため、基準実装では指定すると Codex 監視が無効になる。併せて `TERMINAL_APP_CODEX_HOME` を指定すれば監視するが、その 1 保存先だけを読む。通常・Orca 両方の自動監視は、これらの検証用指定がない通常起動で確認する。独自 dataDir の継続が必要な環境では設定を勝手に解除せず、この監視の制約を記録する。両保存先への対応を同時に満たすには追加の実装修正が必要。

## 5. クロコマースへ取り込む手順

1. 移行先の remote、既定ブランチ、作業中の差分、既存の自己診断・引き継ぎ資料を確認する。資料の `kurocoma/terminal-app` は候補なので、実際の remote と一致させる。
2. 移行先の既定ブランチから専用ブランチを作る。作業中の checkout を維持する必要がある場合は ASCII パスの別 checkout / worktree を使う。`.env.local` を巻き戻す stash / checkout / reset は行わない。
3. Travel-Connect の対応ブランチを追加 remote から fetch し、基準 SHA が取得できたことを確認する。既存 remote の URL は変更しない。
4. 共通祖先と差分を確認する。履歴が共有されている現在の 2 リポジトリでは、基準コミットの merge を第一候補とする。移行先独自の自己診断・資料を保持し、競合は小さな差分で解決する。履歴が異なる場合は依存基盤を含めて必要な差分を移植する。
5. 移行先で定められたチェックと `npm test`、`npm run typecheck`、`npm run lint`、`npm run build` を実行する。lockfile が整合する checkout では `npm ci` で依存関係を用意する。
6. 検証済みコードで terminal-app を起動する。稼働中のアプリを終了する必要がある場合は作業を保存し、切替対象を確認する。設定の一括選択で Orca に切り替える。
7. 既存フォルダを Orca に追加する。ターミナルが既にあれば再利用し、なければ「立ち上げる」または「起こす」で作る。エージェントは Orca 側で起動する。
8. 次節の動作を確認し、変更を移行先への PR にまとめる。資料へ取り込んだ SHA・検証結果・未確認事項を記録する。

一括設定を UI から操作できない場合は、terminal-app を安全に終了して設定ファイルをローカルにバックアップし、全プロジェクトの `clickTarget` と `config.defaultClickTarget` を `"orca"` にする。既存 JSON を解析し、その他の値を保持して保存する。起動中の直接編集は保存の競合が起きるため避ける。設定・バックアップは PR に含めない。

## 6. 完了条件と切り分け

| 確認 | 合格条件 / 問題の切り分け |
|---|---|
| 設定と再起動 | 全対象のクリック先と新規登録の既定が Orca。再起動後も保持 |
| フォルダの対応 | 登録パスとエージェントの cwd が一致。別 worktree は実パスを登録 |
| タイルクリック | 窓の前面化と、目的のセッションのタブ選択を両方確認。同じフォルダの複数セッションも区別 |
| Claude / Codex の監視 | 実行中・完了の表示を確認。Codex が出なければ通常と Orca 用の保存先、`monitorCodex`、`TERMINAL_APP_DATA_DIR` による無効化、`TERMINAL_APP_CODEX_HOME` による単一 home 指定を確認 |
| 返信・中断 | 使い捨てセッションでのみ送信して確認。実作業のセッションへ検証用の入力を送らない |
| スリープ | 使い捨て workspace の Sleep で専用表示と通知抑制を確認。「起こす」で端末作成を確認 |
| CLI の一覧 | `--limit 1000` でも `truncated` なら全件取得成功とはしない。取得失敗時の接続表示だけでタブ対応成功と判断しない |

画面プレビューが表示されても返信できるとは限らない。送信には session ID の一致、最新のペイン所有者、同種の `agentIdentity`、プロセス生存が必要。特定できない場合は Orca で直接入力する。

Orca に登録しただけの未使用フォルダも、端末が 0 ならスリープ扱いになる。明示的な Sleep 記録を読んでいるわけではない。古い Orca が `liveTerminalCount` を返さない場合はスリープを判定できない。

Cursor に戻す場合は設定の一括選択を Cursor にし、各フォルダを Cursor で開く。登録情報や会話履歴を削除する必要はない。保存していたウィンドウ位置は Cursor と Orca で用途が異なるため、必要なら移行先アプリで記憶し直す。

## 7. 実装上の判断と根拠

- Orca は 1 枚の窓で全フォルダを扱い、タイトルにフォルダ名が入らない。Cursor のタイトル検索を流用せず、CLI と Win32 前面化を組み合わせた。
- `Orca.exe <folder>` ではなく CLI の `open`、`repo add`、`terminal create --worktree path:<dir> --focus` を使う。`terminal switch` だけでは OS の前面化を保証しない。
- Codex の複数保存先は会話 ID ごとに統合し、新しい結果を採用する。生存判定は発見した home の writer lock で行う。DB は読み取り専用。
- 中断は Esc。`terminal send --interrupt` は Ctrl+C のため使わない。返信は 1 行へ整形し、フラグに見える文字列も `--text=<値>` 形式で渡す。
- 画面・返信・指示本文・トークンをログや共有成果物へ記録しない。CLI の接続トークンは CLI 自身に扱わせる。

基準コミットの根拠:

- [README の Orca 利用説明](https://github.com/Travel-Connect/terminal-app/blob/6e23614525bdd24624c7fd7de4c93d96dad6056b/README.md)、[当時の実装・検証記録](https://github.com/Travel-Connect/terminal-app/blob/6e23614525bdd24624c7fd7de4c93d96dad6056b/plans/261005-orca-extensions.md)
- [Orca 連携](https://github.com/Travel-Connect/terminal-app/blob/6e23614525bdd24624c7fd7de4c93d96dad6056b/src/main/orca.ts)、[設定の一括保存](https://github.com/Travel-Connect/terminal-app/blob/6e23614525bdd24624c7fd7de4c93d96dad6056b/src/main/project-store.ts)
- [Codex の複数保存先](https://github.com/Travel-Connect/terminal-app/blob/6e23614525bdd24624c7fd7de4c93d96dad6056b/src/main/codex-monitor.ts)、[指示履歴](https://github.com/Travel-Connect/terminal-app/blob/6e23614525bdd24624c7fd7de4c93d96dad6056b/src/main/instructions.ts)
- [Orca のテスト](https://github.com/Travel-Connect/terminal-app/blob/6e23614525bdd24624c7fd7de4c93d96dad6056b/tests/orca.test.ts)、[送信先・中断のテスト](https://github.com/Travel-Connect/terminal-app/blob/6e23614525bdd24624c7fd7de4c93d96dad6056b/tests/orca-interact.test.ts)、[複数保存先のテスト](https://github.com/Travel-Connect/terminal-app/blob/6e23614525bdd24624c7fd7de4c93d96dad6056b/tests/codex-monitor-homes.test.ts)

## 8. 今回の確認範囲

GitHub の両リポジトリとブランチ・PR、ローカルの基準コミットのコード、Orca が返す CLI ガイド・各コマンドの help を確認した。稼働中の Orca で `status`、`worktree ps --limit 1000`、`terminal list --limit 1000` の成功と一覧が打ち切られていないことを確認した。画面本文や認証情報は資料へ収録していない。

基準コードに対して次の既存テストを今回実行し、5 ファイル・38 テストが成功した。資料の UTF-8、コードブロック、相互リンクと参照先コミット・ファイルも確認した。

```text
npx vitest run tests/orca.test.ts tests/orca-interact.test.ts tests/codex-monitor-homes.test.ts tests/project-store-click-target.test.ts tests/instructions.test.ts
```

当時の記録には typecheck / lint / build / dry-run、使い捨て端末での引用符・日本語・Esc 等の確認がある。これは今回の移行先での実行結果ではない。クロコマースの PC での認証・設定切替・タブ選択・返信・Sleep は、移行実行時に上記の完了条件で確認する。

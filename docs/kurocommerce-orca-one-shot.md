# クロコマース向け: Cursor → Orca のワンショット依頼文

クロコマース側の terminal-app を開いた Codex / Claude Code に、下の依頼文を丸ごと渡す。移行先の checkout が分かる環境なら、パスの書き換えは不要。

「ワンショット」は一度の依頼で調査・取り込み・設定・検証・PR まで進める意味。Orca やエージェントの初回認証など、本人の操作が必要な箇所はその条件を伝える。稼働中の実作業セッションを検証用の送信先にしない。

## そのまま渡す依頼文

```text
クロコマースの terminal-app を、トラベルコネクトで実施した Cursor → Orca 移行と同じ動作にしてください。調査や計画の提示だけで止めず、必要なコードの取り込み、ローカル設定、検証、移行記録の更新、移行先への PR 作成まで進めてください。PR のマージと本番への適用は含めません。

参照元にアクセスできます:
- https://github.com/Travel-Connect/terminal-app
- Orca 対応ブランチ: fix/cursor-launch-environment
- 再現基準コミット: 6e23614525bdd24624c7fd7de4c93d96dad6056b
- 主な実装: 9540a07（Orca 連携）と 6e23614（スリープ表示）
- 移行記録:
  https://github.com/Travel-Connect/terminal-app/blob/docs/cursor-to-orca-migration/docs/cursor-to-orca-migration.md
- 実装時の README:
  https://github.com/Travel-Connect/terminal-app/blob/6e23614525bdd24624c7fd7de4c93d96dad6056b/README.md

移行先は現在開いているクロコマースの terminal-app です。候補は kurocoma/terminal-app ですが、既存 remote と既定ブランチから確定してください。Travel-Connect のリポジトリは参照元です。

まず現在の AGENTS.md、git status、remote、既定ブランチ、package.json、必須チェックを確認してください。2026-10-05 の確認では Travel-Connect の main は 0863e62、kurocoma の main は 9302b04 で、どちらの main にも Orca 対応はありませんでした。現在の状態を取得し直して判断してください。移行先の自己診断・引き継ぎ資料などの独自変更を保持してください。

コードの取り込み:
1. 作業中の変更を保全し、移行先の既定ブランチを基点に専用ブランチを用意してください。必要なら ASCII パスの別 checkout / worktree を使ってください。
2. 既存 remote を書き換えず、Travel-Connect の対応ブランチを fetch してください。基準 SHA が取得でき、Orca の実装と依存コードを含むことを確認してください。
3. 共通祖先と差分を確認し、履歴が共有されていれば基準コミットを merge する方法を優先してください。Orca の 2 コミットだけを cherry-pick して Codex 監視などの依存基盤を落とさないでください。競合は既存構成に合わせて小さな差分で解決してください。
4. すでに対応済みなら重複取り込みをせず、不足する差分と設定だけを補ってください。後続修正を採用する場合は根拠と採用した SHA を記録してください。

ローカル環境と設定:
5. Windows 11、Node.js 22+、npm、Git、curl.exe、Orca とその CLI を確認してください。CLI は通常 %LOCALAPPDATA%\Programs\orca\resources\bin\orca.exe です。PATH に無くてもこの実行ファイルを使えます。インストールした版の skills get orca-cli --json と --help で仕様を確認してください。
6. Orca が未導入なら公式配布元を確認し、今回の依頼範囲で可能な導入作業を進めてください。本人のログイン・認証操作が必要なら、対象と必要な操作を具体的に伝えてください。その操作に依存しないコード取り込み・検証・PR は先に終えてください。
7. 使っている terminal-app のデータ保存先を確認し、設定変更前に projects.json / config.json をローカルにバックアップしてください。通常は %APPDATA%\terminal-app\ です。TERMINAL_APP_DATA_DIR の指定があればそれを尊重してください。バックアップはコミットしないでください。
   基準実装では TERMINAL_APP_DATA_DIR 指定時は Codex 監視が無効になり、TERMINAL_APP_CODEX_HOME を併用すると単一 home だけを監視します。両保存先の自動監視は検証用指定のない通常起動で確認してください。検証変数の残存なら意図を確認して通常起動へ戻し、意図的な独自 dataDir 運用なら保持して監視の制約を報告してください。独自 dataDir と両 home 監視を同時に満たすには追加修正が必要なので、通常起動での成功と混同しないでください。
8. 検証済みのコードで起動し、設定画面の「クリックで開くアプリ（一括）」を Orca にしてください。既存全プロジェクトと、今後の新規登録の既定値を両方変更してください。UI を操作できない場合は稼働アプリを安全に終了してから JSON を解析し、各 clickTarget と config.defaultClickTarget を "orca" に変更してください。既存の表示名、パス、並び順、ポート、その他の設定を保持し、再起動後の反映も確認してください。
9. terminal-app に登録された既存フォルダを Orca に登録してください。すでに登録済みのフォルダと端末は再利用し、重複作成を避けてください。エージェントを動かす cwd を登録パスと一致させてください。Orca が新しい worktree を作る運用では、その実パスも terminal-app に登録してください。フォルダを開くために Orca.exe <folder> は使わず、対応 CLI の repo add / terminal create を使ってください。
10. 「立ち上げる」「起こす」は端末を作る機能です。Claude / Codex の起動・認証は Orca 側で確認してください。稼働アプリの切替や停止が必要な場合は、対象と未保存の作業を確認し、安全に進めてください。

検証と完了条件:
11. 依存関係は整合する lockfile があれば npm ci で用意してください。プロジェクトの必須チェックに加え、npm test、npm run typecheck、npm run lint、npm run build を実行してください。今回の変更による失敗は直して再実行してください。既存の失敗は原因を分けて報告し、成功扱いにしないでください。
12. 次を確認してください:
    - 一括 Orca 設定と新規登録の既定が再起動後も保持される。
    - タイルをクリックすると Orca が前面に出て、そのセッションのタブへ移る。同じフォルダの複数セッションを取り違えない。
    - Claude と Codex の実行中・完了を表示する。Codex は通常の保存先と %APPDATA%\orca\codex-runtime-home\home を併せて監視する。
    - Orca の Codex 承認待ちが「確認待ち」になる。
    - ホバーの画面プレビュー・最近の指示、右クリックの返信パネル、変更ファイルの差分表示が動く。
    - 返信と中断は正確な送信先を特定できるときだけ有効。使い捨てセッションで確認し、中断は Esc を使う。terminal send --interrupt は使わない。
    - 使い捨て workspace の Sleep で「☾ スリープ中（Orca）」となり、切断通知を出さない。「起こす」で端末が作られる。
    - 登録フォルダ、未接続、スリープ、別 worktree を区別できる。
13. 再実行しても remote、登録プロジェクト、端末、取り込みコミットが重複しないようにしてください。検証のために実作業中のセッションへ送信・中断をしないでください。

必ず守ること:
- .env.local をリセット・上書き・削除しない。巻き戻す stash / checkout / reset を使わない。
- PW、Token、RefreshToken、接続情報、会話・画面・返信本文をログ、PR、証跡へ出さない。
- 他の PC の Codex / Orca の認証情報や会話 DB を移植しない。この PC の本人の認証を使う。
- .claude/settings.json と Orca の hooks を保持し、terminal-app の hooks だけを安全にマージする。
- 他の作業の差分をコミットに含めない。既存テストを弱めて成功扱いにしない。
- CLI の成功や入力 accepted だけで画面動作・エージェントの開始まで確認済みとしない。

最後に、移行先への PR URL、取り込んだ SHA、変更したローカル設定とバックアップ場所、実行したチェックの結果、確認できた動作、本人の操作待ち・未確認事項、Cursor へ戻す操作を短く報告してください。必要な認証待ちがあっても、独立して完了できる工程を先に完了してください。
```

## 依頼を受けた担当者向けの取得例

以下は既存 remote を変更せずに参照元を取得する例。remote が存在すれば URL を確認して再利用する。`merge` は作業差分を保全した移行専用ブランチで行う。

```powershell
git remote -v
git remote add travelconnect-migration https://github.com/Travel-Connect/terminal-app.git
git fetch travelconnect-migration fix/cursor-launch-environment
git show --no-patch 6e23614525bdd24624c7fd7de4c93d96dad6056b
git merge --no-ff 6e23614525bdd24624c7fd7de4c93d96dad6056b
```

履歴が異なる場合や取り込み済みの場合は、この例を機械的に実行せず、依頼文の手順に従って差分を判断する。Orca の登録・端末作成も、先に `repo list` / `terminal list` で既存状態を確認する。

## 結果として残す記録

| 項目 | 記録内容 |
|---|---|
| 移行先 | repository / branch / checkout パス |
| 取得元 | Travel-Connect の採用 SHA、取り込み方式 |
| 設定 | dataDir、バックアップ場所、クリック先、新規登録の既定 |
| パス対応 | terminal-app の登録パスと Orca で動く cwd |
| チェック | test / typecheck / lint / build / プロジェクト固有チェックの結果 |
| 実操作 | タブ選択、監視、承認待ち、画面、返信・Esc、差分、Sleep・起こす、再起動 |
| 残作業 | 認証待ち、未確認の操作、実際に残る問題 |
| 戻し方 | 一括クリック先を Cursor に戻して対象フォルダを開く |
| PR | クロコマース側への PR URL。ローカル設定・認証・証跡の本文は含めない |

詳しい背景と制約は [移行記録](cursor-to-orca-migration.md)を参照。

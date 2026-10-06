# Cursor 起動時の環境変数継承の検証（2026-09-30）

原因は `src/main/app-launcher.ts` の `spawn()` が親プロセスの環境をそのまま継承していたこと。
Codex のコマンド実行環境で terminal-app を起動すると、「立ち上げる」で開いた Cursor と
その統合ターミナルに `NO_COLOR=1` と `TERM=dumb` が届く。

## 修正

`CODEX_CI`、`CODEX_SESSION_ID`、`CODEX_THREAD_ID` のいずれかが設定されている場合、
起動先へ渡す環境のコピーからこの3変数と `NO_COLOR=1`、`TERM=dumb`、`FORCE_COLOR=0` を除く。
親プロセスの環境は変更しない。通常の起動ではユーザーの色・端末設定を維持し、
PATH、認証に必要な環境、`CODEX_HOME` などもそのまま渡す。

## 実 Cursor での結果

本番の `launchProjectApp()` を使って実際の Cursor.exe を起動。
検証だけの `--user-data-dir`、`--extensions-dir` と一時拡張を追加し、
拡張ホストと統合 PowerShell（`-NoProfile`）で対象変数を確認した。
起動オプションの `env` は本番処理が生成したものを変更せず使用している。

| 対象 | 修正前 | 修正後 |
|---|---|---|
| `NO_COLOR` | 設定あり、無色化あり | 未設定 |
| `TERM` | 設定あり、`dumb` | 未設定 |
| Codex の3識別変数 | 全て設定あり | 全て未設定 |
| 拡張ホストと統合 PowerShell | 上記の汚染を再現 | 両方で除去を確認 |

証跡は [修正前](evidence/20260930-launch-environment/before.json) と
[修正後](evidence/20260930-launch-environment/fixed.json)。
識別変数はダミー値を使い、証跡には存在判定だけを保存した。
既存の Cursor は閉じていない。検証用の隔離プロセスは終了済み。

```powershell
# 修正前のビルドに対して汚染を確認
node scripts/verify-launch-environment.mjs before

# 修正後を確認（Windows と Cursor のインストールが必要）
npm run build
node scripts/verify-launch-environment.mjs fixed
```

回帰テストは旧実装で5件失敗し、修正後に起動処理の14件が成功。
実 Node 子プロセスでも対象変数が届かないことを確認した。
全体の検証は `npm test`（78ファイル・712件）、`npm run typecheck`、
`npm run lint`、`npm run build`、`npm run smoke:win32` が成功。

## 反映と検証の範囲

ビルド後、terminal-app のメニューから再起動する。
既に起動済みの Cursor の環境はこの修正では書き換わらない。
Cursor は既存インスタンスへ起動要求を渡すことがあるため、汚染された環境を確実に解消するには
作業を保存して Cursor を全て終了してから、terminal-app の「立ち上げる」で開き直す。
統合ターミナルも新しく作成する。

今回確認したのは実 Cursor の拡張ホストと統合ターミナルまで。
Claude Code のロゴや `/effort` の画面そのものは未確認。

# リリース手順

npm パッケージ `@uehaj/semgrep` と GitHub のタグ・Release を同じコミットから出すための手順。
スクリプト `scripts/release.sh` が下の 1〜6 をまとめて行う。

```sh
sh scripts/release.sh patch     # 0.2.1 -> 0.2.2  (バグ修正、README)
sh scripts/release.sh minor     # 0.2.1 -> 0.3.0  (オプション追加など互換のある機能)
sh scripts/release.sh major     # 0.2.1 -> 1.0.0  (オプションの意味変更など互換のない変更)
sh scripts/release.sh 0.3.0     # 番号を直接指定
```

## 前提（スクリプトが確認する）

1. `main` ブランチにいる
2. 作業ツリーがきれい（未コミットの変更がない）
3. `HEAD` が `origin/main` と一致している。PR は先にマージし、`git pull` してから出す
4. `npm whoami` が通る
5. `npm test` が OK (`tests/offline.sh` と `tests/check.sh`)

3 を守らないと、npm の版と GitHub のタグの中身がずれる（0.2.0 で実際に起きた。PR #2 のマージ前に publish したため、
npm の 0.2.0 にはレビュー対応が入っていない）。

## スクリプトがやること

1. `npm version <bump>` で `package.json` を書き換え、`vX.Y.Z` のコミットとタグを作る
2. `git push --follow-tags` でコミットとタグを送る
3. `npm publish --access public`。2 要素認証はブラウザで行う（npm 11 の既定）。**対話端末から実行する**。
   Claude Code の `!` 経由や CI では OTP を渡せないので失敗する
4. `gh release create vX.Y.Z --generate-notes` で GitHub Release を作る。本文は前のタグ以降の PR とコミットから自動生成
5. 確認コマンドを表示する

## 手で確認すること

```sh
npm view @uehaj/semgrep version        # 反映まで数分かかることがある
npx @uehaj/semgrep@X.Y.Z --help
```

## 失敗したときの戻し方

- `npm version` の後、`git push` の前に失敗した: `git tag -d vX.Y.Z && git reset --hard HEAD~1`
- push 後、`npm publish` で失敗した: 原因を直して `npm publish --access public` だけ再実行。タグはそのまま使う
- publish 後に間違いに気づいた: npm は同じ番号に上書きできない。直して次の番号を出す。
  公開から 72 時間以内なら `npm unpublish @uehaj/semgrep@X.Y.Z` で取り下げられる

## 版番号の目安

| 変更 | bump |
|---|---|
| バグ修正、README、ヘルプ文言 | patch |
| オプション追加、既定値の変更で互換があるもの | minor |
| オプションの意味変更（`-c` を件数表示にした 0.2.0 のような変更）、削除 | major（1.0 まではminor で代用） |

## コミットの作者

このリポジトリの `git config user.email` は GitHub の noreply アドレスに設定してある。会社メールは使わない。

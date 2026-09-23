# semgrep — 意味で探す grep

[English version](README.md)

背景と設計の解説: [Jevのキラーアプリ、「意味で探す grep」を作った（Zenn）](https://zenn.dev/uehaj/articles/jev-semgrep-grep-by-meaning)

正規表現ではなく **意味** で行を探す grep です。
判定には [TypeSafe AI](https://typesafe.ai/) の System One モデル **Jev** を使います。
Jev は文章を生成せず、typed な質問に確率だけを返すモデルなので、1 行ごとに
「この行は『ネットワーク障害』の意味に合うか」と聞き、返ってきた確率を閾値で切ります。

```sh
./semgrep -n -e "顧客が怒っている、または不満を持っている" tickets.txt
```

- 依存ゼロ。1 ファイル、Node.js 20.12 以降と `fetch` だけで動きます。
- 速い。30 行を 1 リクエストにまとめ、8 本並列で投げます。210 行のファイルが 1 秒弱で終わります。
- 意味は AND / OR / NOT で自由に組み合わせられます。
- **言語を問わない。** 意味も本文もどの言語でも構いません。日本語の意味でフランス語・ロシア語・中国語・韓国語の行が同じように見つかります。翻訳は挟まず、速度も費用も同じです。

## 言語をまたいで探せる

意味と本文の言語が違っていても構いません。Jev は語ではなく概念を照合するので、
1 つの問い合わせでファイル中のあらゆる言語の行が対象になります。

**英語**の意味で**日本語**の行が見つかります。どの行にも angry / frustrated の語はなく、うち 2 行は日本語です。

```sh
$ ./semgrep -n -e "customer is angry or frustrated" tests/corpus.txt
14:ユーザー山田さんからの問い合わせ: 返金してほしい、商品が壊れていた
16:ユーザー佐藤さんからの問い合わせ: 注文した覚えのない請求が来ています。至急確認してください
18:I want my money back. The item arrived broken and customer service ignored me.
21:Your product ruined my weekend. Never buying from you again.
23:This is the third time I'm writing. Nobody has replied to my previous emails.
```

**日本語**の意味で**英語**の行が、日本語の行と同じ確信度で見つかります。

```sh
$ ./semgrep -n -p -e "返金の要求" tests/corpus.txt
14:ユーザー山田さんからの問い合わせ: 返金してほしい、商品が壊れていた	[0.97]
18:I want my money back. The item arrived broken and customer service ignored me.	[0.95]
```

日英に限った話ではありません。`tests/multi.txt` には仏・露・独・西・中・韓の返金要求と感謝の文が入っています。
日本語の意味 1 つで 6 言語の返金要求がすべて見つかり、ロシア語で書いた意味でも同じ結果になります。

```sh
$ ./semgrep -n -p -e "顧客が返金を求めている" tests/multi.txt
1:Je veux être remboursé, le produit est arrivé cassé.	[0.98]
3:Я требую вернуть деньги, товар не работает.	[0.97]
5:Ich möchte mein Geld zurück, das Gerät ist defekt.	[0.97]
7:Quiero un reembolso, el paquete llegó vacío.	[0.97]
9:我要求退款，商品坏了。	[0.97]
11:환불해 주세요. 제품이 고장났어요.	[0.97]

$ ./semgrep -n -p -e "клиент требует возврат денег" tests/multi.txt
1:Je veux être remboursé, le produit est arrivé cassé.	[0.94]
3:Я требую вернуть деньги, товар не работает.	[0.97]
5:Ich möchte mein Geld zurück, das Gerät ist defekt.	[0.92]
7:Quiero un reembolso, el paquete llegó vacío.	[0.89]
9:我要求退款，商品坏了。	[0.92]
11:환불해 주세요. 제품이 고장났어요.	[0.89]
```

多言語が混ざったログや問い合わせのダンプ、メンバーごとに問い合わせの言語が違うチームで効きます。
注意点が 1 つあります。TypeSafe は英語の精度が最も高いと明記しており、手元の実測でも日本語の意味は
閾値付近でややぶれます。際どい問い合わせは英語で書く方が安定します。

## ベクトル検索と何が違うのか

「X に関係のある行」が欲しいだけなら、埋め込みのコサイン類似度でも同じ行が出ます。違うのは判定の中身です。
semgrep は話題の近さではなく、その行について **命題が成り立つか** を判定します。Jev は行と質問を同時に読んで
答える（cross-encoder 型の）モデルなので、誰が何をしたか、否定、「求めている」のか「済んだ」のかで答えが変わります。
行の埋め込みは質問を見る前に固定されるので、測れるのは話題の近さまでです。

次の 6 行はどれも「返金の話」ですが、顧客が返金を求めているのは 2 行だけです。

```sh
$ ./semgrep -n -p -t 0 -e "customer is asking for a refund" tests/contrast.txt
1:返金してほしい。商品が壊れていた	[0.98]
2:返金処理が完了しましたのでご確認ください	[0.10]
3:当社の返金ポリシーは購入後30日以内です	[0.10]
4:The manager denied the refund request yesterday	[0.17]
5:I demand a full refund immediately	[0.94]
6:Refunds are processed within 5 business days	[0.08]
```

意味ごとに独立した確率が出るので、**論理的な AND と NOT がそのままブール演算になります**。
集合の引き算や「否定クエリ」の工夫は要りません。

```sh
# 返金の話だが、顧客が求めているのではない → 完了報告、ポリシー、却下、日数
$ ./semgrep -n -e "about a refund" -v "the customer is asking for a refund" tests/contrast.txt
2:返金処理が完了しましたのでご確認ください
3:当社の返金ポリシーは購入後30日以内です
4:The manager denied the refund request yesterday
6:Refunds are processed within 5 business days

# 怒っている、かつ、それが顧客であってスタッフではない
$ ./semgrep -n -e "someone is angry" -a "the customer, not the staff, is the one acting" tests/contrast.txt
5:I demand a full refund immediately
8:顧客が怒って電話を切った
```

7 行目の `カスタマーサポート担当者が怒って電話を切った` は、2 つ目の意味で 0.05 となり除外されます。
7 行目と 8 行目のコサイン類似度はほぼ 1 です。

実用上の帰結が 2 つあります。確率は較正されているので閾値 0.5 がどの質問にも使えます。コサイン類似度は
top-k か質問ごとの閾値調整が要ります。また索引を作らず、目の前のファイルにそのまま当てられます。
裏返すと、問い合わせのたびにコーパス全体分を払うので、同じ大きなコーパスに何度も問い合わせるなら
ベクトル索引の方が安くて速いです。

## インストール

使い方は 2 通りあります。コマンドラインツールとして使う（この節）か、Claude Code のスキルとして使う
（後述の [Claude Code から使う](#claude-code-から使う)）か。スキルは `npx @uehaj/semgrep` に自動で切り替わるので、
Claude Code からしか使わないならここでのインストールは不要で、API キーの設定だけで済みます。

Node.js 20.12 以降が必要です。ほかの依存はありません。

```sh
npm install -g @uehaj/semgrep
semgrep --help
```

インストールせずに試すなら `npx` で実行できます（初回だけダウンロードし、2 回目以降はキャッシュから起動します）。

```sh
npx @uehaj/semgrep -n -e "顧客が怒っている、または不満を持っている" tickets.txt
```

次に [TypeSafe のコンソール](https://console.typesafe.ai/) で取得した API キーを渡します。どれか 1 つで構いません。

```sh
export SEMGREP_API_KEY=your-key                       # 環境変数
echo 'SEMGREP_API_KEY=your-key' > ~/.config/semgrep/.env    # ユーザー単位 (先に mkdir -p)
echo 'SEMGREP_API_KEY=your-key' > .env                # プロジェクト単位。カレントディレクトリから読む
```

環境変数が優先で、足りない分は `./.env`、`~/.config/semgrep/.env` のうち最初に見つかった方から補います。
`SEMGREP_API_KEY` が無ければ `TYPESAFE_API_KEY` も使えます。

### 他のエンドポイント

semgrep が読む設定は `SEMGREP_API_KEY`（または `TYPESAFE_API_KEY`）、`SEMGREP_URL`、`SEMGREP_MODEL` の 3 つだけです。
TypeSafe の `POST /v1/systemone` と同じ形で話すエンドポイントなら使えます。キーは `SEMGREP_URL` の先へそのまま
送られるので、2 つは組にして設定してください。

```sh
# OpenRouter
SEMGREP_URL=https://openrouter.ai/api/v1/systemone SEMGREP_API_KEY=sk-or-... semgrep -e ...
# Vercel AI Gateway
SEMGREP_URL=https://ai-gateway.vercel.sh/typesafe/v1/systemone SEMGREP_MODEL=typesafe-ai/jev SEMGREP_API_KEY=vck_... semgrep -e ...
# キーの要らない互換サーバ: Authorization ヘッダを付けずに送る
SEMGREP_URL=http://localhost:8000/v1/systemone semgrep -e ...
```

集計行には、エンドポイントが返した費用（`usage.cost`）を出します。TypeSafe 本体の場合は定価での推定を `~` 付きで出します。

ソースから使うなら `git clone https://github.com/uehaj/jev-semgrep.git && cd jev-semgrep && npm install -g .`、
またはそのまま `node semgrep.mjs ...` で動きます。

> 静的解析ツールの [Semgrep](https://semgrep.dev/) と同名です。両方使うならどちらかを別名にしてください。

## 例

例はすべて [`tests/corpus.txt`](tests/corpus.txt) に対するものです。サーバログ、日英の問い合わせ、
ソースコード、SQL、雑談が混ざった 51 行のファイルです。

### 概念で探す。言語は問わない

```sh
$ ./semgrep -n -e "customer is angry or frustrated" tests/corpus.txt
14:ユーザー山田さんからの問い合わせ: 返金してほしい、商品が壊れていた
16:ユーザー佐藤さんからの問い合わせ: 注文した覚えのない請求が来ています。至急確認してください
18:I want my money back. The item arrived broken and customer service ignored me.
21:Your product ruined my weekend. Never buying from you again.
23:This is the third time I'm writing. Nobody has replied to my previous emails.
5/51 lines, 2 requests, 3225 input tokens
```

どの行にも「angry」「frustrated」という語はありません。英語の意味で日本語の行も拾えています。

### OR で 2 つの意味。`-p` で確率も見る

```sh
$ ./semgrep -n -p -e "返金の要求" -e "配送先の変更依頼" tests/corpus.txt
14:ユーザー山田さんからの問い合わせ: 返金してほしい、商品が壊れていた	[0.97 0.02]
17:ユーザー高橋さんからの問い合わせ: 配送先の住所を変更したいのですが	[0.01 0.96]
18:I want my money back. The item arrived broken and customer service ignored me.	[0.96 0.01]
22:Can I change the delivery address for order #8821?	[0.02 0.96]
4/51 lines, 2 requests, 4602 input tokens
```

末尾の括弧が、指定した順に各意味の確率です。閾値を決めるときの目安になります。

`--color`（端末では既定で有効）を付けると、確率が閾値に対して色分けされます。
`-t` 以上は緑、`-T` 未満は赤、あいだは黄です。行番号とファイル名は grep と同じ配色です。

![色付き出力: 行番号は緑、確率は緑または赤](docs/color.svg)

### AND NOT。ネットワーク障害のうちリトライ中のものを除く

```sh
$ ./semgrep -n -e "ネットワークやリモート接続の障害" -v "a retry is happening or was attempted" tests/corpus.txt
4:2026-09-19 08:02:30 ERROR connection reset by peer while calling payment-gateway
6:2026-09-19 08:02:35 ERROR timeout after 5000ms waiting for payment-gateway
9:2026-09-19 08:10:44 ERROR DNS lookup failed for api.example.com
11:2026-09-19 09:00:00 ERROR SSL handshake failed: certificate expired
13:network unreachable: no route to host 10.0.0.5
30:except ConnectionError as e:
31:    logger.error("upstream unreachable: %s", e)
7/51 lines, 2 requests, 5112 input tokens
```

5 行目の `retrying payment-gateway request (attempt 2/3)` はネットワーク障害ですが、`-v` で落ちています。

### 混合。(金融 AND 悪いニュース) OR 天気

```sh
$ ./semgrep -n -e "about economy, finance or markets" -a "the news is negative or a decline" -e "about weather" tests/corpus.txt
36:今日の天気は晴れ、最高気温は28度です
43:Stock prices fell 3% after the earnings report missed expectations.
48:明日は雨の予報なので傘を持っていきます
3/51 lines, 2 requests, 5673 input tokens
```

`The central bank raised interest rates` は金融の話ですが下落ではないので外れています。

### 厳しさのプリセット

```sh
$ ./semgrep --level strict -n -e "a security risk or dangerous destructive operation" tests/corpus.txt
33:DROP TABLE sessions;
49:API keys must never be committed to the repository.

$ ./semgrep --level loose -n -e "a security risk or dangerous destructive operation" tests/corpus.txt
11:2026-09-19 09:00:00 ERROR SSL handshake failed: certificate expired
16:ユーザー佐藤さんからの問い合わせ: 注文した覚えのない請求が来ています。至急確認してください
33:DROP TABLE sessions;
49:API keys must never be committed to the repository.
```

`strict` はモデルが確信している行だけ、`loose` は期限切れ証明書や身に覚えのない請求まで拾います。

### ディレクトリを再帰検索、ファイル名だけ表示

```sh
$ ./semgrep -r -n -e "customer is asking for a refund" docs/
docs/tickets/a.txt:7:ユーザー山田さんからの問い合わせ: 返金してほしい、商品が壊れていた
docs/tickets/sub/b.txt:1:The customer wants a refund for the broken lamp.

$ ./semgrep -rl -e "customer is asking for a refund" docs/
docs/tickets/a.txt
docs/tickets/sub/b.txt
```

`-r` はディレクトリを名前順にたどり、`.git`、`node_modules`、`.ssh`、`.aws`、`.gnupg`、バイナリ（先頭 8 KB に NUL がある）、
秘密情報になりがちなファイル（`.env*`、`*.pem`、`*.key`、`*.p12`、`*.pfx`、`id_rsa` など）を飛ばします。
**検索対象の行はすべて TypeSafe の API に送られる**ので、スキャンするつもりのディレクトリだけを指定してください。
コマンドラインで明示したファイルは、除外リストに該当しても検索します。
`-l` は一致したファイルを見つかった順に 1 回ずつ表示し、`-r` の有無にかかわらず使えます。`-c` は行の代わりにファイルごとの一致行数を出します。

### 「〜でない」行を全部

```sh
./semgrep -v "a timestamped server log line" mixed.txt   # grep -v 相当
./semgrep -e "source code or SQL" -v "SQL" src.txt       # コードだが SQL ではない
cat app.log | ./semgrep -e "デプロイが失敗した、またはロールバックされた"
```

### 複数行にまたがるレコード (`-z`)

判定の単位は行です。ログやソースにはそれでよいのですが、1 件のレコードが複数行にまたがるときは合いません。
`-z` を付けると単位が NUL 終端のレコードになります。`grep -z` と同じ意味なので、レコードを出力するツールと
そのまま繋がります。`git log -z`、`find -print0`、`xargs -0` などです。

「このコミットはユーザーに見える振る舞いを変えている」という命題は、コミット全体について成り立つもので、
その中のどの 1 行についてでもありません。

```sh
$ git log -z --format='%h %s %b' | ./semgrep -z -n -e "ユーザーに見える振る舞いを変えている" -v "ドキュメントだけの変更"
7:21120e9 Revert "feat: ship the /semgrep Claude Code skill" ...
8:51ae333 feat: ship the /semgrep Claude Code skill
```

一致したレコードも NUL 終端で出力されるので、読むときは `tr '\0' '\n'` に通してください。
ファイル名 (`-l`) と件数 (`-c`) は grep と同じく改行のままです。`-z` のとき `-n` はレコード番号、
`-A` / `-B` / `-C` は前後のレコード数、`--chunk` は 1 リクエストのレコード数を数えます。

## Claude Code から使う

semgrep を代わりに走らせてくれる Claude Code のスキルがあります。探したいものを言葉で書くと、式を組み立てて
検索し、`file:line` 付きで該当行を報告します。[`uehaj/uehaj-marketplace`](https://github.com/uehaj/uehaj-marketplace) マーケットプレースの
`uehaj` プラグインとして公開しています。

```sh
claude plugin marketplace add uehaj/uehaj-marketplace
claude plugin install uehaj@uehaj-marketplace
```

コマンドラインツールを別途インストールする必要はありません。スキルは PATH に `semgrep` があればそれを、
無ければ `npx @uehaj/semgrep` を使います。必要なのは API キーの設定だけです（[インストール](#インストール) を参照）。

あとは Claude Code の中で次のように打ちます。

```
/uehaj:semgrep 返金を求めている問い合わせ tickets/*.txt
/uehaj:semgrep 未テストのまま入った修正 git log --oneline -200
```

Claude Code のインストール単位はプラグインで、スキル単体は選べません。このスキルだけ欲しいときは
[skills CLI](https://skills.sh/) が `~/.claude/skills/` にコピーしてくれ、その場合は `/semgrep` で呼びます。

```sh
npx skills add uehaj/uehaj-marketplace --skill semgrep -a claude-code -g
```

スキルは意味を英語で書き、AND / OR / NOT を `-e` / `-a` / `-v` に振り分け、`-n` を付け、大きなディレクトリは
課金に見合うファイルに絞り、最初の結果が怪しければ `--level loose` や `strict` で引き直します。
API キーとエンドポイントの読み方はコマンドラインと同じです（`SEMGREP_API_KEY`、`./.env`、`~/.config/semgrep/.env`）。

## 使い方

```
usage: semgrep [OPTION]... -e MEANING [-a MEANING] [-v MEANING]... [FILE...]

  -e MEANING   この意味に合う行 (複数指定は OR)
  -a MEANING   直前の -e 項に AND で連結。-e A -a B -e C は (A and B) or C
  -v MEANING   直前の -e 項に AND NOT で連結。-e A -v B は A and not B
               先頭に置けば単独の否定。-v B は not B (grep -v 相当)
  !MEANING     -e / -a / -v のどこでも、先頭に ! を付けるとその意味だけ否定
               -e A -e '!B' は A or not B。-a '!C' は -v C と同じ
  --level=LEVEL 厳しさ。肯定と否定の閾値をまとめて決める (既定 normal)
                 loose  : -t 0.3 -T 0.7  多少あやしくても拾う
                 normal : -t 0.5 -T 0.5
                 strict : -t 0.7 -T 0.3  確信のある行だけ拾う
  -t THRESH    肯定条件の閾値。確率 >= THRESH で一致 (--level より優先)
  -T THRESH    否定条件の閾値。確率 < THRESH で「〜でない」と判定 (--level より優先)
               -t 0.6 -T 0.3 なら 0.3〜0.6 の曖昧な行はどちらにも当たらない
  -r           ディレクトリを再帰的に探す (FILE 省略時はカレント)。.git と node_modules、
               バイナリファイルは飛ばす
  -l           一致した行ではなくファイル名だけを表示
  -A NUM       一致行の後ろ NUM 行も表示 (grep と同じ。文脈行の区切りは - )
  -B NUM       一致行の前 NUM 行も表示
  -C NUM       前後 NUM 行を表示 (-A NUM -B NUM)
  -c           一致した行数だけをファイルごとに表示 (grep -c 相当)
  --chunk=LINES 1 リクエストにまとめる行数 (既定 30)
  -j N         同時リクエスト数 (既定 8)
  -n           行番号を付ける
  -p           各意味の確率を行末に表示 (閾値調整用)
  --color[=WHEN] 色付け。auto (端末なら付ける、既定) / always / never。=WHEN 省略時は auto
               ファイル名・行番号は grep と同じ配色。-p の確率は閾値以上を緑、
               否定側の閾値未満を赤、あいだを黄で表示。NO_COLOR にも従う
  -h, --help   このヘルプ (LANG / LC_ALL / LC_MESSAGES が ja 以外なら英語)
```

FILE を省略すると stdin を読みます。複数ファイルなら `file:` を前置きします。
終了コードは grep と同じで、一致あり 0、なし 1、エラー 2（引数エラー、読めないファイル、API 障害）です。

### 式の書き方

`-e` が OR の項を始め、`-a` / `-v` は直前の項に AND / AND NOT で連結します。
意味の先頭に `!` を付けるとその意味だけを否定できます（シェルの履歴展開を避けるためシングルクォートで囲んでください）。

| コマンド | 意味 |
|---|---|
| `-e A -e B` | A or B |
| `-e A -a B` | A and B |
| `-e A -v B` | A and not B |
| `-e A -a B -v C -e D` | (A and B and not C) or D |
| `-e A -e '!B'` | A or not B |
| `-v B` | not B |

## 仕組み

1. 空行を除いた行を 30 行ずつ（文字数上限つき）のチャンクに分ける
2. チャンクを `{"L000": "行1", "L001": "行2", ...}` という object として `state` に入れ、
   行 × 意味 の数だけ `noul`（yes/no 確率）質問を 1 リクエストにまとめて送る
3. 8 本まで並列にリクエストし、結果はファイル順に出力する
4. 各行について、意味ごとの確率を閾値で真偽に変え、AND / OR / NOT の式を評価する

行をまとめても、1 行ずつ送った場合と確率はほぼ変わりません（30 行で 1 リクエスト約 0.2 秒、
1 行ずつだと約 7 秒）。チャンクを大きくしすぎると閾値付近の行が落ちやすくなるので既定は 30 行です。
確率は実行ごとに ±0.05 ほどぶれます。閾値を詰めるときは `-p` で確率を見てください。

料金は入力 100 万トークンあたり 0.042 ドル（2026 年 9 月時点）で、2 つの意味で 30 行のチャンクが
約 3,000 トークンです。上限はレート制限（1,200 リクエスト/分）で決まり、既定設定なら毎分およそ
36,000 行です。

## テスト

`tests/` に LLM-as-judge のテストがあります。`tests/corpus.txt`（51 行）に対して `tests/cases.json` の
10 ケースを実行し、Claude（`claude -p`）が「各意味に本当に合致する行」を判定した結果と突き合わせて
precision / recall を出します。あわせて `-t` × `-T` を 0.05 刻みで総当たりし、最良の閾値を報告します。

```sh
node --no-warnings tests/judge.mts [--model sonnet] [--rejudge]
```

ジャッジの判定は `tests/verdicts.json` にキャッシュされ、2 回目以降はジャッジを呼びません。
結果は `tests/report.md` に書き出されます。直近の結果は precision 0.94、recall 0.98 です。

## 制約

- 検索した行はすべて api.typesafe.ai に送られます。そこにアップロードしたくないファイルには使わないでください。
- 空行は送らず、全意味の確率 0 として扱います。`-v X` には当たり、`-e X` には当たりません。
- 1 行は 2,000 文字で切って送ります。
- 1 リクエストの質問数上限は公式に書かれていませんが、420 質問は通っています。
- 429 / 529 は指数バックオフで 6 回まで再試行します。
- 精度は英語がもっとも高く、日本語も使えますがぶれは大きめです。

## ライセンス

MIT

# currency

Exchange rates and conversion from the European Central Bank (via Frankfurter). No API key, no account.

## Workflow

- "100 美元是多少人民币" → `currency.latest` with `amount: 100`, `from: USD`, `to: CNY`.
- "欧元和日元呢" → one call, `to: "EUR,JPY"` — do not call once per currency.
- "上个月美元兑人民币怎么走的" → `currency.history` with a date range, then render a small line chart or a table.
- Unsure whether a code exists → `currency.currencies` first (it is ~30 codes, all ECB currencies).

## Rules

- **Only ~30 currencies exist here**, and they are the ECB reference set: CNY, USD, EUR, JPY, GBP, HKD, KRW… but **not** crypto, not TWD, not every exotic code. If a call returns `{"message":"not found"}`, read `currency.currencies` and tell the user the code is unsupported — do not retry it.
- **The date is a working day.** On a weekend the newest available date is Friday's. Do not present the rate as "right now"; give the date the response contains (`date` field).
- **Show the units.** `amount` is the base amount, so "100 USD = 669.28 CNY" is right; dropping `amount` means the rate is per 1 unit.
- `history` returns the **actual** covered range as `start_date` / `end_date`; weekends and holidays are missing. Say "9 月 1–30 日（其中 6 天没有数据）" rather than implying a value for every day.
- Round sensibly (2 decimals for fiat) and always show which currency pair and which date.
- This is reference data, not trading advice, and it is not live-ticking. Do not add commentary about markets.

## When something is empty or fails

- HTTP 404 + `not found` → bad currency code or an empty date range. Check the code list; do not retry in a loop.
- The request fails in the browser → the network is down or something is blocking `api.frankfurter.app`. Report it; the service needs no key, so it is not a configuration problem.

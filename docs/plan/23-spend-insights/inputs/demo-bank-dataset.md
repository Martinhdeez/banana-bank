# Demo bank dataset (DS2 and DS3, as built)

Status: as built, 2026-10-07 (DS2, then DS3: 170 rows added, none changed). This is the dataset `npm run demo` serves: the content of
`tests/alt-bank/demo-seed.json`. It replaces [`demo-bank-dataset-proposal.md`](demo-bank-dataset-proposal.md)
as the table the demo bank is checked against; the proposal stays as the record of SI9 (its rows for
Lucía and Bruno are all still here, unchanged: same ids, dates, amounts and texts).

How it is made, so that it can be regenerated and reconciled:

- The rows are written in [`gen-demo-seed.mjs`](gen-demo-seed.mjs) (one line per movement) and
  `node docs/plan/23-spend-insights/inputs/gen-demo-seed.mjs` writes the seed file. It refuses a
  duplicate id and an account that would go under €5.00.
- The tables below are printed from the running demo bank through the app's own bank view and the rules
  (`DECIDER=none`, no model):
  `node --import tsx .scratch/after/feat-ds3-realistic-demo-data/ds3-table.mjs --md docs/plan/23-spend-insights/inputs/demo-bank-dataset.md`.
  `tests/si9-demo-bank.test.ts` fails when a `demo-` row of this file and the seed file differ.

Facts of the dataset:

- **Window:** 1 July to 6 October 2026 (Europe/Madrid; CEST, UTC+2, for the whole window): three full
  months and the first days of October. Every initial deposit is dated 1 July 2026, 08:00
  (`openingAt` of the seed file).
- **Every customer has rows**: no customer of the demo bank has the default `Card payment N` rows any
  more. Without `ALT_BANK_SEED_FILE` the alt bank is unchanged (30 `Card payment` rows each, the
  fixture of `tests/alt-bank.test.ts` for a history longer than the 25-movement page). On the demo bank
  that case is real rows: every customer has more than 25 movements.
- **Ids:** `demo-<customer>-NNN`. Lucía's rows 1–32 and Bruno's 1–29 are the SI9 ones; their new rows
  continue from 33 and 30, so their numbers are not in date order. The other six were numbered by date
  in DS2. **The rows DS3 added continue after each customer's last id, in the order they are written in
  the generator** (Lucía 051–080, Bruno 050–069, Carla 053–078, Diego 059–065, Elena 051–077, Hugo
  059–073, Inés 059–075, Omar 051–078): no id that existed names another row.
  A transfer between roster accounts is an operation of the bank and its two movements have random
  ids: "(transfer)" in the tables. References: `demo-<customer>-savings-07|08|09` (own savings: Lucía
  200.00, Carla 250.00, Elena 300.00, Inés 150.00 in July and September), `demo-hugo-rent-07|08|09`
  (Hugo → Omar, 400.00), and the two the bank always seeds, `ref-historic-lucia` (Lucía → Bruno, 85.00,
  "Team dinner") and `ref-historic-elena` (Elena → Hugo, 25.00), both on 23 September.
- **No raw account id in a seeded text:** a seeded transfer reads as its concept (`ahorro mensual`) when
  it is between the customer's own accounts and as `Transfer · <concept>` otherwise.
- **Balances kept:** `acc-lucia` 2,937.61, `acc-lucia-savings` 1,300.00, `acc-bruno` 4,592.52 (the
  documented transfer scenes) and `acc-diego` 75.00 (the insufficient-funds checks) are those of before
  DS2; DS3 kept all twelve balances of DS2. The openings rose instead, by what each customer's new rows
  spend.
- **Kept for the scenes:** Lucía's `TRANSFERENCIA 000123` (25 Aug, 150.00, to review), her MERCADONA
  rows, `LA ESQUINA SL` (3, to review) and `EL CORTE INGLES`; Bruno's `SUMUP *ESPAI NOU` (4, to review)
  and `CUOTA AUTONOMOS TGSS` (2). Every row DS2 or DS3 added is decided by a rule, so the movements to
  review are the same for everyone (Lucía 7, Bruno 9). Since DS3 Lucía's and Bruno's August and
  September hold more than the SI9 rows, so their totals of those months changed; Bruno's "Eating out &
  leisure" did not (€59.90 in September, 3 payments; €39.20 in August, 2), nor did anybody's "Other".
- **CAT1 (contracts 2.36): no row changed, the rules did.** Bruno's `CUOTA AUTONOMOS TGSS` (2) and
  `ADOBE *CREATIVE CLOUD` (2) and Omar's `GITHUB, INC.` (3) and `NOTION LABS INC` (1) are now
  "Work & projects" by rule. To review: Bruno 5 (was 9: `ESPAI NOU` 4, `PAYPAL *JGARCIA88` 1), Omar 7
  (was 11); the other six as before. Bruno's and Omar's "Other" fell by those amounts.
- **A month reads like a real one (DS3):** housing (rent or mortgage and utilities) is 38% to 55% of a
  full month's spending for the seven customers who pay for one, and groceries are the next block the
  rules name, in four to eight trips a month: about €310–340 for Lucía, €245–255 for Bruno, €250–290
  for Carla, €390–405 for Elena, €205–220 for Hugo, €320–330 for Inés, €315–330 for Omar, and €80–110
  for Diego, a student whose income leaves no more. Inés owns her home: groceries are her first block.
  Bruno's, Diego's and Hugo's rent is a transfer, which the rules name "Transfers to people". Per
  customer and month, from the app's own answers:
  `.scratch/after/feat-ds3-realistic-demo-data/after-per-customer.txt`.
- **What a new row must not do** (the generator's header says it too): repeat a merchant the month
  forecast calls usual (one charge in each of July, August and September, days within 5, amounts within
  15%), become one, or lift a category's September above its August by €15 and 25% (`category_up`).
  Every customer's page stays under the bank's 100 movements (66 to 86).
- **The current month is not empty:** every customer has 8 to 10 rows from 1 to 6 October 2026, with
  at least two grocery trips, and the rules place their spending in at least six categories other than
  "Other". September has at least five such categories for every customer. The rent or mortgage of the
  first days is still 67% to 81% of October so far for the five who have paid one.
- **"By the rules"** is the outcome with `DECIDER=none`: a category id means a rule decided it; "to
  review" means the rules left it for the customer (or for a model when one is configured).

| Customer | Persona | Movements | Jul / Aug / Sep / Oct | Shown by rules | To review | Last month (Sep 2026): spent, income | Balances today (EUR) |
|---|---|---|---|---|---|---|---|
| lucia | Lucía Martín: consultant in Madrid, salaried (2,150.00 on the 28th), rents, saves 200.00 a month | 86 | 27 / 23 / 26 / 10 | 79 | 7 | 1,927.98, 2,150.00 | Personal savings 1,300.00; Aurora account 2,937.61 |
| bruno | Bruno Vidal: freelance designer in Valencia, invoices paid irregularly (880.00 to 1,650.00), orders in a lot | 70 | 21 / 18 / 22 / 9 | 65 | 5 | 1,640.01, 2,715.00 | Horizon account 4,592.52 |
| carla | Carla Ríos: nurse in Barcelona, salaried (1,890.00), rents, saves 250.00 a month for a trip | 86 | 27 / 26 / 24 / 9 | 75 | 11 | 1,749.62, 1,890.00 | Personal savings 1,650.00; Aurora account 2,089.01 |
| diego | Diego Salas: student in Granada, part-time job (380.00 to 420.00) and 250.00 from family, very low balance | 66 | 18 / 19 / 21 / 8 | 58 | 8 | 628.13, 644.00 | Horizon account 75.00 |
| elena | Elena Costa: engineer in Bilbao, salaried (2,480.00), mortgage and school costs, saves 300.00 a month | 86 | 25 / 24 / 28 / 9 | 79 | 7 | 2,112.30, 2,480.00 | Personal savings 1,800.00; Aurora account 2,863.96 |
| hugo | Hugo Pérez: warehouse worker in Sevilla, paid weekly through a temp agency (330.00), rides a motorbike, rents a room from Omar | 78 | 24 / 21 / 24 / 9 | 71 | 7 | 1,012.24, 1,345.00 | Horizon account 3,472.12 |
| ines | Inés López: retired teacher in Zaragoza, pension (1,340.00), small frequent purchases and cash | 81 | 23 / 21 / 28 / 9 | 75 | 6 | 965.20, 1,340.00 | Personal savings 1,200.00; Aurora account 4,832.85 |
| omar | Omar León: remote developer in Málaga, paid by a Dutch company (2,900.00), receives 400.00 rent from Hugo | 82 | 24 / 24 / 26 / 8 | 75 | 7 | 2,271.71, 3,300.00 | Horizon account 6,160.22 |

## lucia

Lucía Martín — `acc-lucia-savings` Personal savings, €1,300.00 today; `acc-lucia` Aurora account, €2,937.61 today. 86 movements, 79 shown by rules, 7 to review.

| Id | Date, time (Madrid) | Account | Amount (EUR) | Description | By the rules (`DECIDER=none`) |
|---|---|---|---|---|---|
| `m-open-acc-lucia` | 2026-07-01 08:00 | `acc-lucia` | 4,096.34 | `Initial deposit` | `other` |
| `m-open-acc-lucia-savings` | 2026-07-01 08:00 | `acc-lucia-savings` | 700.00 | `Initial deposit` | `other` |
| `demo-lucia-033` | 2026-07-01 08:00 | `acc-lucia` | -950.00 | `RECIBO ALQUILER INMOB. CASTELLANA 41 SL` | `home_utilities` |
| `demo-lucia-034` | 2026-07-03 19:15 | `acc-lucia` | -47.80 | `COMPRA TARJ. 4532XXXXXXXX1234 MERCADONA 0412 MADRID ES` | `groceries` |
| `demo-lucia-051` | 2026-07-04 22:10 | `acc-lucia` | -46.80 | `RESTAURANTE EL RINCON DE CHAMBERI` | `eating_out_leisure` |
| `demo-lucia-052` | 2026-07-05 09:15 | `acc-lucia` | -43.60 | `RENFE VIAJEROS INTERNET MADRID` | `transport` |
| `demo-lucia-035` | 2026-07-06 08:00 | `acc-lucia` | -58.12 | `RECIBO IBERDROLA CLIENTES SAU` | `home_utilities` |
| `demo-lucia-053` | 2026-07-08 19:05 | `acc-lucia` | -68.40 | `COMPRA TARJ. 4532XXXXXXXX1234 MERCADONA 0412 MADRID ES` | `groceries` |
| `demo-lucia-036` | 2026-07-10 08:00 | `acc-lucia` | -39.90 | `RECIBO DIGI SPAIN TELECOM SLU` | `home_utilities` |
| `demo-lucia-037` | 2026-07-11 21:40 | `acc-lucia` | -32.50 | `RESTAURANTE LA MUSA LATINA MADRID` | `eating_out_leisure` |
| `demo-lucia-054` | 2026-07-12 12:40 | `acc-lucia` | -109.00 | `IKEA SAN SEBASTIAN DE LOS REYES` | `shopping` |
| `demo-lucia-038` | 2026-07-14 06:00 | `acc-lucia` | -10.99 | `PAYPAL *SPOTIFY 35314369001` | `eating_out_leisure` |
| `demo-lucia-055` | 2026-07-14 20:15 | `acc-lucia` | -42.90 | `CARREFOUR EXPRESS 0871 MADRID` | `groceries` |
| `demo-lucia-039` | 2026-07-17 18:30 | `acc-lucia` | -8.95 | `FARMACIA LDA. M. RUIZ 0001` | `health` |
| `demo-lucia-040` | 2026-07-18 11:30 | `acc-lucia` | -63.41 | `COMPRA TARJ. 4532XXXXXXXX1234 MERCADONA 0412 MADRID ES` | `groceries` |
| `demo-lucia-056` | 2026-07-19 14:30 | `acc-lucia` | -28.50 | `VIPS 0231 MADRID` | `eating_out_leisure` |
| `demo-lucia-057` | 2026-07-21 18:20 | `acc-lucia` | -45.99 | `MANGO GOYA MADRID` | `shopping` |
| `demo-lucia-041` | 2026-07-22 20:10 | `acc-lucia` | -29.99 | `PRIMARK GRAN VIA MADRID` | `shopping` |
| `demo-lucia-058` | 2026-07-23 17:00 | `acc-lucia` | -55.00 | `CLINICA DENTAL CHAMBERI SLP` | `health` |
| `demo-lucia-059` | 2026-07-24 18:50 | `acc-lucia` | -81.25 | `COMPRA TARJ. 4532XXXXXXXX1234 MERCADONA 0412 MADRID ES` | `groceries` |
| `demo-lucia-042` | 2026-07-25 22:20 | `acc-lucia` | -19.80 | `CINESA PROYECCIONES MADRID` | `eating_out_leisure` |
| `demo-lucia-060` | 2026-07-26 21:00 | `acc-lucia` | -54.00 | `TICKETMASTER ES 0034871` | `eating_out_leisure` |
| `demo-lucia-043` | 2026-07-28 08:00 | `acc-lucia` | 2,150.00 | `NOMINA JULIO ACME CONSULTING SL` | `income` |
| (transfer) | 2026-07-29 09:00 | `acc-lucia` | -200.00 | `ahorro mensual` | `savings_internal` |
| (transfer) | 2026-07-29 09:00 | `acc-lucia-savings` | 200.00 | `ahorro mensual` | `savings_internal` |
| `demo-lucia-061` | 2026-07-29 19:40 | `acc-lucia` | -37.35 | `LIDL SUPERMERCADOS SAU MADRID` | `groceries` |
| `demo-lucia-044` | 2026-07-31 08:10 | `acc-lucia` | -32.70 | `RECARGA ABONO TRANSPORTE CRTM` | `transport` |
| `demo-lucia-062` | 2026-08-01 20:30 | `acc-lucia` | -64.80 | `COMPRA TARJ. 4532XXXXXXXX1234 MERCADONA 0412 MADRID ES` | `groceries` |
| `demo-lucia-001` | 2026-08-04 08:00 | `acc-lucia` | -950.00 | `RECIBO ALQUILER INMOB. CASTELLANA 41 SL` | `home_utilities` |
| `demo-lucia-002` | 2026-08-05 08:00 | `acc-lucia` | -67.43 | `RECIBO IBERDROLA CLIENTES SAU` | `home_utilities` |
| `demo-lucia-063` | 2026-08-07 22:00 | `acc-lucia` | -58.40 | `RESTAURANTE LA MUSA LATINA MADRID` | `eating_out_leisure` |
| `demo-lucia-003` | 2026-08-08 11:20 | `acc-lucia` | -54.32 | `COMPRA TARJ. 4532XXXXXXXX1234 MERCADONA 0412 MADRID ES` | `groceries` |
| `demo-lucia-004` | 2026-08-10 08:00 | `acc-lucia` | -39.90 | `RECIBO DIGI SPAIN TELECOM SLU` | `home_utilities` |
| `demo-lucia-064` | 2026-08-12 13:10 | `acc-lucia` | -34.20 | `RENFE VIAJEROS INTERNET MADRID` | `transport` |
| `demo-lucia-065` | 2026-08-13 19:20 | `acc-lucia` | -88.35 | `CARREFOUR EXPRESS 0871 MADRID` | `groceries` |
| `demo-lucia-005` | 2026-08-14 06:00 | `acc-lucia` | -10.99 | `PAYPAL *SPOTIFY 35314369001` | `eating_out_leisure` |
| `demo-lucia-066` | 2026-08-15 14:20 | `acc-lucia` | -44.90 | `RESTAURANTE EL RINCON DE CHAMBERI` | `eating_out_leisure` |
| `demo-lucia-006` | 2026-08-16 01:30 | `acc-lucia` | -14.00 | `LA ESQUINA SL` | to review |
| `demo-lucia-067` | 2026-08-18 18:40 | `acc-lucia` | -59.95 | `ZARA ESPANA S.A. 3321 MADRID` | `shopping` |
| `demo-lucia-007` | 2026-08-19 23:00 | `acc-lucia` | -23.99 | `AMZN Mktp ES*2K4LL0P93` | to review |
| `demo-lucia-068` | 2026-08-20 17:30 | `acc-lucia` | -28.30 | `FARMACIA LDA. M. RUIZ 0001` | `health` |
| `demo-lucia-008` | 2026-08-22 11:05 | `acc-lucia` | -61.07 | `COMPRA TARJ. 4532XXXXXXXX1234 MERCADONA 0412 MADRID ES` | `groceries` |
| `demo-lucia-069` | 2026-08-23 22:10 | `acc-lucia` | -24.60 | `CINESA PROYECCIONES MADRID` | `eating_out_leisure` |
| `demo-lucia-009` | 2026-08-25 10:00 | `acc-lucia` | -150.00 | `TRANSFERENCIA 000123` | to review |
| `demo-lucia-070` | 2026-08-26 19:15 | `acc-lucia` | -51.90 | `LIDL SUPERMERCADOS SAU MADRID` | `groceries` |
| `demo-lucia-071` | 2026-08-27 12:30 | `acc-lucia` | -62.90 | `FNAC CALLAO MADRID` | `shopping` |
| `demo-lucia-010` | 2026-08-28 08:00 | `acc-lucia` | 2,150.00 | `NOMINA AGOSTO ACME CONSULTING SL` | `income` |
| (transfer) | 2026-08-29 09:00 | `acc-lucia` | -200.00 | `ahorro mensual` | `savings_internal` |
| (transfer) | 2026-08-29 09:00 | `acc-lucia-savings` | 200.00 | `ahorro mensual` | `savings_internal` |
| `demo-lucia-012` | 2026-08-31 08:10 | `acc-lucia` | -32.70 | `RECARGA ABONO TRANSPORTE CRTM` | `transport` |
| `demo-lucia-013` | 2026-09-01 08:00 | `acc-lucia` | -950.00 | `RECIBO ALQUILER INMOB. CASTELLANA 41 SL` | `home_utilities` |
| `demo-lucia-014` | 2026-09-05 08:00 | `acc-lucia` | -71.20 | `RECIBO IBERDROLA CLIENTES SAU` | `home_utilities` |
| `demo-lucia-015` | 2026-09-05 12:10 | `acc-lucia` | -48.90 | `COMPRA TARJ. 4532XXXXXXXX1234 MERCADONA 0412 MADRID ES` | `groceries` |
| `demo-lucia-016` | 2026-09-06 02:10 | `acc-lucia` | -21.50 | `LA ESQUINA SL` | to review |
| `demo-lucia-017` | 2026-09-08 18:20 | `acc-lucia` | -12.45 | `FARMACIA LDA. M. RUIZ 0001` | `health` |
| `demo-lucia-018` | 2026-09-10 08:00 | `acc-lucia` | -39.90 | `RECIBO DIGI SPAIN TELECOM SLU` | `home_utilities` |
| `demo-lucia-072` | 2026-09-11 19:30 | `acc-lucia` | -41.60 | `LIDL SUPERMERCADOS SAU MADRID` | `groceries` |
| `demo-lucia-019` | 2026-09-12 13:00 | `acc-lucia` | -76.40 | `EL CORTE INGLES 0018 MADRID` | to review |
| `demo-lucia-020` | 2026-09-12 18:30 | `acc-lucia` | -49.95 | `ZARA ESPANA S.A. 3321 MADRID` | `shopping` |
| `demo-lucia-021` | 2026-09-13 00:45 | `acc-lucia` | -16.00 | `LA ESQUINA SL` | to review |
| `demo-lucia-022` | 2026-09-14 06:00 | `acc-lucia` | -10.99 | `PAYPAL *SPOTIFY 35314369001` | `eating_out_leisure` |
| `demo-lucia-073` | 2026-09-16 21:30 | `acc-lucia` | -58.00 | `RESTAURANTE LA MUSA LATINA MADRID` | `eating_out_leisure` |
| `demo-lucia-023` | 2026-09-18 20:00 | `acc-lucia` | -50.00 | `REINTEGRO CAJERO 0921 MADRID` | `other` |
| `demo-lucia-024` | 2026-09-19 11:40 | `acc-lucia` | -72.15 | `COMPRA TARJ. 4532XXXXXXXX1234 MERCADONA 0412 MADRID ES` | `groceries` |
| `demo-lucia-025` | 2026-09-21 22:30 | `acc-lucia` | -41.50 | `AMZN Mktp ES*7HH21MM04` | to review |
| `demo-lucia-074` | 2026-09-22 18:20 | `acc-lucia` | -45.99 | `MANGO GOYA MADRID` | `shopping` |
| (transfer) | 2026-09-23 18:41 | `acc-lucia` | -85.00 | `Transfer · Team dinner` | `transfer_person` |
| `demo-lucia-075` | 2026-09-24 14:15 | `acc-lucia` | -27.50 | `VIPS 0231 MADRID` | `eating_out_leisure` |
| `demo-lucia-076` | 2026-09-26 11:20 | `acc-lucia` | -83.20 | `COMPRA TARJ. 4532XXXXXXXX1234 MERCADONA 0412 MADRID ES` | `groceries` |
| `demo-lucia-027` | 2026-09-27 03:41 | `acc-lucia` | -18.00 | `TPV BAR LA ESQUINA SL 27/09 03:41` | `eating_out_leisure` |
| `demo-lucia-028` | 2026-09-27 04:05 | `acc-lucia` | -11.35 | `UBER *TRIP HELP.UBER.COM NL` | `transport` |
| `demo-lucia-029` | 2026-09-28 08:00 | `acc-lucia` | 2,150.00 | `NOMINA SEPTIEMBRE ACME CONSULTING SL` | `income` |
| (transfer) | 2026-09-29 09:00 | `acc-lucia` | -200.00 | `ahorro mensual` | `savings_internal` |
| (transfer) | 2026-09-29 09:00 | `acc-lucia-savings` | 200.00 | `ahorro mensual` | `savings_internal` |
| `demo-lucia-077` | 2026-09-29 19:10 | `acc-lucia` | -63.70 | `CARREFOUR EXPRESS 0871 MADRID` | `groceries` |
| `demo-lucia-031` | 2026-09-30 08:10 | `acc-lucia` | -32.70 | `RECARGA ABONO TRANSPORTE CRTM` | `transport` |
| `demo-lucia-032` | 2026-10-01 08:00 | `acc-lucia` | -950.00 | `RECIBO ALQUILER INMOB. CASTELLANA 41 SL` | `home_utilities` |
| `demo-lucia-045` | 2026-10-02 19:30 | `acc-lucia` | -52.36 | `COMPRA TARJ. 4532XXXXXXXX1234 MERCADONA 0412 MADRID ES` | `groceries` |
| `demo-lucia-049` | 2026-10-03 11:40 | `acc-lucia` | -34.99 | `ZARA ESPANA S.A. 3321 MADRID` | `shopping` |
| `demo-lucia-046` | 2026-10-03 14:20 | `acc-lucia` | -24.60 | `VIPS 0231 MADRID` | `eating_out_leisure` |
| `demo-lucia-078` | 2026-10-04 11:15 | `acc-lucia` | -18.90 | `LIDL SUPERMERCADOS SAU MADRID` | `groceries` |
| `demo-lucia-047` | 2026-10-04 12:05 | `acc-lucia` | -9.40 | `RENFE CERCANIAS MADRID` | `transport` |
| `demo-lucia-048` | 2026-10-05 08:00 | `acc-lucia` | -61.30 | `RECIBO IBERDROLA CLIENTES SAU` | `home_utilities` |
| `demo-lucia-050` | 2026-10-05 18:25 | `acc-lucia` | -7.60 | `FARMACIA LDA. M. RUIZ 0001` | `health` |
| `demo-lucia-079` | 2026-10-06 14:05 | `acc-lucia` | -13.50 | `RESTAURANTE EL RINCON DE CHAMBERI` | `eating_out_leisure` |
| `demo-lucia-080` | 2026-10-06 19:20 | `acc-lucia` | -78.45 | `CARREFOUR EXPRESS 0871 MADRID` | `groceries` |

## bruno

Bruno Vidal — `acc-bruno` Horizon account, €4,592.52 today. 70 movements, 65 shown by rules, 5 to review.

| Id | Date, time (Madrid) | Account | Amount (EUR) | Description | By the rules (`DECIDER=none`) |
|---|---|---|---|---|---|
| `m-open-acc-bruno` | 2026-07-01 08:00 | `acc-bruno` | 3,517.70 | `Initial deposit` | `other` |
| `demo-bruno-030` | 2026-07-01 09:00 | `acc-bruno` | -620.00 | `TRANSFERENCIA A FAVOR DE M. SORIANO CONCEPTO ALQUILER` | `transfer_person` |
| `demo-bruno-031` | 2026-07-03 19:20 | `acc-bruno` | -41.35 | `Pago en CONSUM COOP V. VALENCIA` | `groceries` |
| `demo-bruno-050` | 2026-07-06 12:10 | `acc-bruno` | -52.30 | `MERCADONA 3318 VALENCIA` | `groceries` |
| `demo-bruno-032` | 2026-07-07 08:00 | `acc-bruno` | 1,250.00 | `TRANSFERENCIA RECIBIDA ESTUDIO NORTE SL FRA 2026-024` | `income` |
| `demo-bruno-033` | 2026-07-09 21:30 | `acc-bruno` | -18.40 | `GLOVO 09JUL VLC7M3 VALENCIA` | `eating_out_leisure` |
| `demo-bruno-051` | 2026-07-11 11:30 | `acc-bruno` | -129.00 | `IKEA ALFAFAR VALENCIA` | `shopping` |
| `demo-bruno-034` | 2026-07-12 10:30 | `acc-bruno` | -9.60 | `FARMACIA RUZAFA 0042` | `health` |
| `demo-bruno-052` | 2026-07-13 07:40 | `acc-bruno` | -38.60 | `RENFE VIAJEROS INTERNET MADRID` | `transport` |
| `demo-bruno-053` | 2026-07-14 19:10 | `acc-bruno` | -61.75 | `Pago en CONSUM COOP V. VALENCIA` | `groceries` |
| `demo-bruno-035` | 2026-07-15 08:00 | `acc-bruno` | -35.00 | `VODAFONE ESPANA SAU RECIBO` | `home_utilities` |
| `demo-bruno-036` | 2026-07-17 20:05 | `acc-bruno` | -36.90 | `Pago en CONSUM COOP V. VALENCIA` | `groceries` |
| `demo-bruno-037` | 2026-07-19 01:10 | `acc-bruno` | -11.40 | `CABIFY ESPANA SLU` | `transport` |
| `demo-bruno-054` | 2026-07-20 17:30 | `acc-bruno` | -60.00 | `CLINICA DENTAL RUZAFA SLP` | `health` |
| `demo-bruno-038` | 2026-07-21 22:15 | `acc-bruno` | -12.50 | `CERVECERIA EL CABANYAL` | `eating_out_leisure` |
| `demo-bruno-055` | 2026-07-23 18:15 | `acc-bruno` | -34.95 | `FNAC VALENCIA SAN AGUSTIN` | `shopping` |
| `demo-bruno-039` | 2026-07-24 22:10 | `acc-bruno` | -22.70 | `GLOVO 24JUL VLC3R8 VALENCIA` | `eating_out_leisure` |
| `demo-bruno-056` | 2026-07-25 12:20 | `acc-bruno` | -34.20 | `LIDL SUPERMERCADOS SAU VALENCIA` | `groceries` |
| `demo-bruno-040` | 2026-07-26 11:40 | `acc-bruno` | -54.99 | `DECATHLON VALENCIA` | `shopping` |
| `demo-bruno-041` | 2026-07-28 08:00 | `acc-bruno` | 880.00 | `TRANSFERENCIA RECIBIDA PIXELWORKS BV INV 109` | `income` |
| `demo-bruno-042` | 2026-07-30 18:45 | `acc-bruno` | -27.64 | `Pago en CONSUM COOP V. VALENCIA` | `groceries` |
| `demo-bruno-057` | 2026-08-01 19:40 | `acc-bruno` | -58.90 | `MERCADONA 3318 VALENCIA` | `groceries` |
| `demo-bruno-001` | 2026-08-04 09:00 | `acc-bruno` | -620.00 | `TRANSFERENCIA A FAVOR DE M. SORIANO CONCEPTO ALQUILER` | `transfer_person` |
| `demo-bruno-002` | 2026-08-06 09:05 | `acc-bruno` | -15.00 | `SUMUP *ESPAI NOU` | to review |
| `demo-bruno-003` | 2026-08-07 19:30 | `acc-bruno` | -38.20 | `Pago en CONSUM COOP V. VALENCIA` | `groceries` |
| `demo-bruno-004` | 2026-08-09 10:00 | `acc-bruno` | -29.21 | `VALENBISI ABONO ANUAL` | `transport` |
| `demo-bruno-005` | 2026-08-12 08:00 | `acc-bruno` | 1,400.00 | `TRANSFERENCIA RECIBIDA ESTUDIO NORTE SL FRA 2026-031` | `income` |
| `demo-bruno-006` | 2026-08-12 21:40 | `acc-bruno` | -17.90 | `GLOVO 12AGO VLC2K7 VALENCIA` | `eating_out_leisure` |
| `demo-bruno-058` | 2026-08-14 12:30 | `acc-bruno` | -29.95 | `ZARA ESPANA S.A. 1147 VALENCIA` | `shopping` |
| `demo-bruno-007` | 2026-08-15 08:00 | `acc-bruno` | -35.00 | `VODAFONE ESPANA SAU RECIBO` | `home_utilities` |
| `demo-bruno-059` | 2026-08-17 11:50 | `acc-bruno` | -47.35 | `LIDL SUPERMERCADOS SAU VALENCIA` | `groceries` |
| `demo-bruno-008` | 2026-08-18 06:00 | `acc-bruno` | -36.29 | `ADOBE *CREATIVE CLOUD` | `work` |
| `demo-bruno-060` | 2026-08-19 18:30 | `acc-bruno` | -14.35 | `FARMACIA RUZAFA 0042` | `health` |
| `demo-bruno-009` | 2026-08-20 09:10 | `acc-bruno` | -15.00 | `SUMUP *ESPAI NOU` | to review |
| `demo-bruno-010` | 2026-08-21 20:10 | `acc-bruno` | -45.67 | `Pago en CONSUM COOP V. VALENCIA` | `groceries` |
| `demo-bruno-011` | 2026-08-27 22:05 | `acc-bruno` | -21.30 | `GLOVO 27AGO VLC9P1 VALENCIA` | `eating_out_leisure` |
| `demo-bruno-061` | 2026-08-28 19:20 | `acc-bruno` | -63.10 | `MERCADONA 3318 VALENCIA` | `groceries` |
| `demo-bruno-062` | 2026-08-29 01:30 | `acc-bruno` | -13.20 | `CABIFY ESPANA SLU` | `transport` |
| `demo-bruno-012` | 2026-08-31 08:00 | `acc-bruno` | -294.00 | `CUOTA AUTONOMOS TGSS` | `work` |
| `demo-bruno-013` | 2026-09-01 09:00 | `acc-bruno` | -620.00 | `TRANSFERENCIA A FAVOR DE M. SORIANO CONCEPTO ALQUILER` | `transfer_person` |
| `demo-bruno-014` | 2026-09-02 21:00 | `acc-bruno` | -40.00 | `PAYPAL *JGARCIA88` | to review |
| `demo-bruno-015` | 2026-09-03 09:00 | `acc-bruno` | -15.00 | `SUMUP *ESPAI NOU` | to review |
| `demo-bruno-016` | 2026-09-04 19:45 | `acc-bruno` | -29.80 | `Pago en CONSUM COOP V. VALENCIA` | `groceries` |
| `demo-bruno-063` | 2026-09-08 19:30 | `acc-bruno` | -55.40 | `MERCADONA 3318 VALENCIA` | `groceries` |
| `demo-bruno-017` | 2026-09-09 08:00 | `acc-bruno` | 980.00 | `TRANSFERENCIA RECIBIDA PIXELWORKS BV INV 118` | `income` |
| `demo-bruno-018` | 2026-09-10 21:15 | `acc-bruno` | -15.60 | `GLOVO 10SEP VLC4T2 VALENCIA` | `eating_out_leisure` |
| `demo-bruno-019` | 2026-09-12 02:20 | `acc-bruno` | -9.80 | `CABIFY ESPANA SLU` | `transport` |
| `demo-bruno-064` | 2026-09-13 12:15 | `acc-bruno` | -66.85 | `Pago en CONSUM COOP V. VALENCIA` | `groceries` |
| `demo-bruno-020` | 2026-09-15 08:00 | `acc-bruno` | -35.00 | `VODAFONE ESPANA SAU RECIBO` | `home_utilities` |
| `demo-bruno-021` | 2026-09-17 09:05 | `acc-bruno` | -15.00 | `SUMUP *ESPAI NOU` | to review |
| `demo-bruno-022` | 2026-09-18 06:00 | `acc-bruno` | -36.29 | `ADOBE *CREATIVE CLOUD` | `work` |
| `demo-bruno-023` | 2026-09-18 20:00 | `acc-bruno` | -51.12 | `Pago en CONSUM COOP V. VALENCIA` | `groceries` |
| `demo-bruno-024` | 2026-09-20 13:00 | `acc-bruno` | -249.00 | `MEDIAMARKT SATURN E-COMMERCE` | `shopping` |
| `demo-bruno-065` | 2026-09-22 18:40 | `acc-bruno` | -8.75 | `FARMACIA RUZAFA 0042` | `health` |
| (transfer) | 2026-09-23 18:41 | `acc-bruno` | 85.00 | `Transfer · Team dinner` | `income` |
| `demo-bruno-026` | 2026-09-24 22:30 | `acc-bruno` | -19.80 | `GLOVO 24SEP VLC1X9 VALENCIA` | `eating_out_leisure` |
| `demo-bruno-066` | 2026-09-25 19:05 | `acc-bruno` | -41.20 | `LIDL SUPERMERCADOS SAU VALENCIA` | `groceries` |
| `demo-bruno-027` | 2026-09-26 23:10 | `acc-bruno` | -24.50 | `CERVECERIA EL CABANYAL` | `eating_out_leisure` |
| `demo-bruno-067` | 2026-09-27 02:10 | `acc-bruno` | -12.90 | `CABIFY ESPANA SLU` | `transport` |
| `demo-bruno-028` | 2026-09-30 08:00 | `acc-bruno` | 1,650.00 | `TRANSFERENCIA RECIBIDA ESTUDIO NORTE SL FRA 2026-038` | `income` |
| `demo-bruno-029` | 2026-09-30 08:05 | `acc-bruno` | -294.00 | `CUOTA AUTONOMOS TGSS` | `work` |
| `demo-bruno-043` | 2026-10-01 09:00 | `acc-bruno` | -620.00 | `TRANSFERENCIA A FAVOR DE M. SORIANO CONCEPTO ALQUILER` | `transfer_person` |
| `demo-bruno-044` | 2026-10-02 19:10 | `acc-bruno` | -33.48 | `Pago en CONSUM COOP V. VALENCIA` | `groceries` |
| `demo-bruno-047` | 2026-10-03 12:30 | `acc-bruno` | -39.99 | `DECATHLON VALENCIA` | `shopping` |
| `demo-bruno-045` | 2026-10-03 21:50 | `acc-bruno` | -19.20 | `GLOVO 03OCT VLC5H2 VALENCIA` | `eating_out_leisure` |
| `demo-bruno-068` | 2026-10-04 12:10 | `acc-bruno` | -22.15 | `LIDL SUPERMERCADOS SAU VALENCIA` | `groceries` |
| `demo-bruno-046` | 2026-10-04 23:30 | `acc-bruno` | -16.00 | `CERVECERIA EL CABANYAL` | `eating_out_leisure` |
| `demo-bruno-048` | 2026-10-05 00:40 | `acc-bruno` | -11.90 | `CABIFY ESPANA SLU` | `transport` |
| `demo-bruno-049` | 2026-10-05 10:15 | `acc-bruno` | -6.85 | `FARMACIA RUZAFA 0042` | `health` |
| `demo-bruno-069` | 2026-10-06 19:25 | `acc-bruno` | -64.90 | `MERCADONA 3318 VALENCIA` | `groceries` |

## carla

Carla Ríos — `acc-carla-savings` Personal savings, €1,650.00 today; `acc-carla` Aurora account, €2,089.01 today. 86 movements, 75 shown by rules, 11 to review.

| Id | Date, time (Madrid) | Account | Amount (EUR) | Description | By the rules (`DECIDER=none`) |
|---|---|---|---|---|---|
| `m-open-acc-carla` | 2026-07-01 08:00 | `acc-carla` | 3,498.07 | `Initial deposit` | `other` |
| `m-open-acc-carla-savings` | 2026-07-01 08:00 | `acc-carla-savings` | 900.00 | `Initial deposit` | `other` |
| `demo-carla-001` | 2026-07-01 08:00 | `acc-carla` | -870.00 | `RECIBO ALQUILER FINQUES LAIETANA SL` | `home_utilities` |
| `demo-carla-002` | 2026-07-02 07:50 | `acc-carla` | -22.00 | `TMB T-USUAL BARCELONA` | `transport` |
| `demo-carla-053` | 2026-07-03 20:40 | `acc-carla` | -42.50 | `RESTAURANTE CAN SOLE BARCELONA` | `eating_out_leisure` |
| `demo-carla-003` | 2026-07-04 18:40 | `acc-carla` | -39.75 | `BONPREU 0214 BARCELONA ES` | `groceries` |
| `demo-carla-004` | 2026-07-06 08:00 | `acc-carla` | -24.99 | `BASIC-FIT SPAIN SAU` | to review |
| `demo-carla-054` | 2026-07-07 19:10 | `acc-carla` | -72.40 | `MERCADONA 4120 BARCELONA` | `groceries` |
| `demo-carla-055` | 2026-07-09 23:40 | `acc-carla` | -11.85 | `CABIFY ESPANA SLU` | `transport` |
| `demo-carla-005` | 2026-07-10 08:00 | `acc-carla` | -61.50 | `ADESLAS SEGURCAIXA RECIBO 07/26` | `health` |
| `demo-carla-006` | 2026-07-11 08:00 | `acc-carla` | -44.35 | `ADEUDO RECIBO ENDESA ENERGIA XXI SLU REF 0098122` | `home_utilities` |
| `demo-carla-056` | 2026-07-12 11:20 | `acc-carla` | -89.90 | `IKEA BADALONA` | `shopping` |
| `demo-carla-007` | 2026-07-14 21:15 | `acc-carla` | -18.90 | `GLOVO 14JUL BCN8K2 BARCELONA` | `eating_out_leisure` |
| `demo-carla-057` | 2026-07-15 18:30 | `acc-carla` | -68.15 | `CAPRABO 0338 BARCELONA` | `groceries` |
| `demo-carla-058` | 2026-07-17 16:00 | `acc-carla` | -65.00 | `CLINICA DENTAL EIXAMPLE SLP` | `health` |
| `demo-carla-008` | 2026-07-18 12:20 | `acc-carla` | -48.30 | `BONPREU 0214 BARCELONA ES` | `groceries` |
| `demo-carla-059` | 2026-07-19 09:20 | `acc-carla` | -29.40 | `RENFE VIAJEROS INTERNET MADRID` | `transport` |
| `demo-carla-009` | 2026-07-20 20:40 | `acc-carla` | -16.40 | `CINESA DIAGONAL MAR` | `eating_out_leisure` |
| `demo-carla-010` | 2026-07-22 08:00 | `acc-carla` | -39.80 | `AIGUES DE BARCELONA FACT 2026-07` | `home_utilities` |
| `demo-carla-060` | 2026-07-23 18:10 | `acc-carla` | -39.99 | `MANGO PASSEIG DE GRACIA` | `shopping` |
| `demo-carla-011` | 2026-07-25 19:30 | `acc-carla` | -34.95 | `PAYPAL *ZALANDO SE 4029357733` | `shopping` |
| `demo-carla-061` | 2026-07-26 21:30 | `acc-carla` | -38.00 | `TICKETMASTER ES 0035120` | `eating_out_leisure` |
| `demo-carla-062` | 2026-07-27 12:40 | `acc-carla` | -58.90 | `CAPRABO 0338 BARCELONA` | `groceries` |
| `demo-carla-012` | 2026-07-28 08:00 | `acc-carla` | 1,890.00 | `NOMINA CLINICA DELTA SLP` | `income` |
| (transfer) | 2026-07-29 09:00 | `acc-carla` | -250.00 | `vacaciones 2027` | `savings_internal` |
| (transfer) | 2026-07-29 09:00 | `acc-carla-savings` | 250.00 | `vacaciones 2027` | `savings_internal` |
| `demo-carla-013` | 2026-07-30 19:10 | `acc-carla` | -7.85 | `FARMACIA DIAGONAL 412` | `health` |
| `demo-carla-063` | 2026-08-02 19:20 | `acc-carla` | -64.30 | `MERCADONA 4120 BARCELONA` | `groceries` |
| `demo-carla-014` | 2026-08-04 07:50 | `acc-carla` | -22.00 | `TMB T-USUAL BARCELONA` | `transport` |
| `demo-carla-015` | 2026-08-04 08:00 | `acc-carla` | -870.00 | `RECIBO ALQUILER FINQUES LAIETANA SL` | `home_utilities` |
| `demo-carla-016` | 2026-08-05 08:00 | `acc-carla` | -24.99 | `BASIC-FIT SPAIN SAU` | to review |
| `demo-carla-064` | 2026-08-07 21:40 | `acc-carla` | -68.00 | `RESTAURANTE CAN SOLE BARCELONA` | `eating_out_leisure` |
| `demo-carla-017` | 2026-08-08 18:30 | `acc-carla` | -42.10 | `BONPREU 0214 BARCELONA ES` | `groceries` |
| `demo-carla-018` | 2026-08-10 08:00 | `acc-carla` | -61.50 | `ADESLAS SEGURCAIXA RECIBO 08/26` | `health` |
| `demo-carla-019` | 2026-08-11 08:00 | `acc-carla` | -48.10 | `ADEUDO RECIBO ENDESA ENERGIA XXI SLU REF 0098123` | `home_utilities` |
| `demo-carla-065` | 2026-08-12 18:15 | `acc-carla` | -59.95 | `ZARA ESPANA S.A. 0418 BARCELONA` | `shopping` |
| `demo-carla-020` | 2026-08-13 07:40 | `acc-carla` | -3.80 | `SQ *THE BREW LAB` | to review |
| `demo-carla-066` | 2026-08-14 09:10 | `acc-carla` | -31.60 | `RENFE VIAJEROS INTERNET MADRID` | `transport` |
| `demo-carla-021` | 2026-08-15 14:10 | `acc-carla` | -27.40 | `TPV 77120034 BARCELONA` | to review |
| `demo-carla-022` | 2026-08-16 21:05 | `acc-carla` | -21.30 | `GLOVO 16AGO BCN2P7 BARCELONA` | `eating_out_leisure` |
| `demo-carla-067` | 2026-08-17 12:10 | `acc-carla` | -81.75 | `CAPRABO 0338 BARCELONA` | `groceries` |
| `demo-carla-068` | 2026-08-19 17:30 | `acc-carla` | -50.00 | `FISIOTERAPIA GRACIA SLP` | `health` |
| `demo-carla-023` | 2026-08-21 22:00 | `acc-carla` | -18.49 | `AMZN Mktp ES*1Z9QW8RR2` | to review |
| `demo-carla-024` | 2026-08-22 08:00 | `acc-carla` | -38.60 | `AIGUES DE BARCELONA FACT 2026-08` | `home_utilities` |
| `demo-carla-025` | 2026-08-23 12:15 | `acc-carla` | -37.85 | `BONPREU 0214 BARCELONA ES` | `groceries` |
| `demo-carla-069` | 2026-08-24 22:10 | `acc-carla` | -27.00 | `YELMO CINES ICARIA` | `eating_out_leisure` |
| `demo-carla-070` | 2026-08-26 18:40 | `acc-carla` | -52.49 | `DECATHLON BARCELONA CENTRE` | `shopping` |
| `demo-carla-026` | 2026-08-28 08:00 | `acc-carla` | 1,890.00 | `NOMINA CLINICA DELTA SLP` | `income` |
| `demo-carla-071` | 2026-08-28 23:55 | `acc-carla` | -14.20 | `CABIFY ESPANA SLU` | `transport` |
| (transfer) | 2026-08-29 09:00 | `acc-carla` | -250.00 | `vacaciones 2027` | `savings_internal` |
| (transfer) | 2026-08-29 09:00 | `acc-carla-savings` | 250.00 | `vacaciones 2027` | `savings_internal` |
| `demo-carla-072` | 2026-08-30 11:30 | `acc-carla` | -59.20 | `MERCADONA 4120 BARCELONA` | `groceries` |
| `demo-carla-027` | 2026-08-30 19:20 | `acc-carla` | -9.60 | `FARMACIA DIAGONAL 412` | `health` |
| `demo-carla-028` | 2026-09-02 07:35 | `acc-carla` | -3.80 | `SQ *THE BREW LAB` | to review |
| `demo-carla-029` | 2026-09-03 08:00 | `acc-carla` | -870.00 | `RECIBO ALQUILER FINQUES LAIETANA SL` | `home_utilities` |
| `demo-carla-030` | 2026-09-04 07:50 | `acc-carla` | -22.00 | `TMB T-USUAL BARCELONA` | `transport` |
| `demo-carla-031` | 2026-09-05 08:00 | `acc-carla` | -24.99 | `BASIC-FIT SPAIN SAU` | to review |
| `demo-carla-032` | 2026-09-06 11:30 | `acc-carla` | -55.20 | `BONPREU 0214 BARCELONA ES` | `groceries` |
| `demo-carla-033` | 2026-09-07 22:40 | `acc-carla` | -84.90 | `PAYPAL *ZALANDO SE 4029357733` | `shopping` |
| `demo-carla-034` | 2026-09-10 08:00 | `acc-carla` | -61.50 | `ADESLAS SEGURCAIXA RECIBO 09/26` | `health` |
| `demo-carla-035` | 2026-09-11 08:00 | `acc-carla` | -52.60 | `ADEUDO RECIBO ENDESA ENERGIA XXI SLU REF 0098124` | `home_utilities` |
| `demo-carla-073` | 2026-09-12 19:15 | `acc-carla` | -78.60 | `MERCADONA 4120 BARCELONA` | `groceries` |
| `demo-carla-036` | 2026-09-13 14:10 | `acc-carla` | -12.00 | `COMPRA TARJ. 5412XXXX 0098231 ES` | to review |
| `demo-carla-037` | 2026-09-15 10:00 | `acc-carla` | 39.95 | `DEVOLUCION PAYPAL *ZALANDO` | `shopping` |
| `demo-carla-038` | 2026-09-16 07:40 | `acc-carla` | -3.80 | `SQ *THE BREW LAB` | to review |
| `demo-carla-074` | 2026-09-18 21:20 | `acc-carla` | -36.50 | `RESTAURANTE CAN SOLE BARCELONA` | `eating_out_leisure` |
| `demo-carla-039` | 2026-09-19 21:30 | `acc-carla` | -17.80 | `CINESA DIAGONAL MAR` | `eating_out_leisure` |
| `demo-carla-040` | 2026-09-19 23:50 | `acc-carla` | -15.00 | `BIZUM ENVIADO A MARTA P.` | `transfer_person` |
| `demo-carla-041` | 2026-09-20 12:00 | `acc-carla` | -44.75 | `BONPREU 0214 BARCELONA ES` | `groceries` |
| `demo-carla-042` | 2026-09-22 08:00 | `acc-carla` | -41.30 | `AIGUES DE BARCELONA FACT 2026-09` | `home_utilities` |
| `demo-carla-043` | 2026-09-25 19:00 | `acc-carla` | -200.00 | `REVOLUT**7741* DUBLIN` | to review |
| `demo-carla-044` | 2026-09-26 16:00 | `acc-carla` | -64.99 | `VUELING AIRLINES BCN` | `transport` |
| `demo-carla-075` | 2026-09-27 12:20 | `acc-carla` | -29.99 | `MANGO PASSEIG DE GRACIA` | `shopping` |
| `demo-carla-045` | 2026-09-28 08:00 | `acc-carla` | 1,890.00 | `NOMINA CLINICA DELTA SLP` | `income` |
| `demo-carla-076` | 2026-09-28 11:40 | `acc-carla` | -69.85 | `CAPRABO 0338 BARCELONA` | `groceries` |
| (transfer) | 2026-09-29 09:00 | `acc-carla` | -250.00 | `vacaciones 2027` | `savings_internal` |
| (transfer) | 2026-09-29 09:00 | `acc-carla-savings` | 250.00 | `vacaciones 2027` | `savings_internal` |
| `demo-carla-046` | 2026-10-01 08:00 | `acc-carla` | -870.00 | `RECIBO ALQUILER FINQUES LAIETANA SL` | `home_utilities` |
| `demo-carla-047` | 2026-10-02 07:50 | `acc-carla` | -22.00 | `TMB T-USUAL BARCELONA` | `transport` |
| `demo-carla-048` | 2026-10-02 19:40 | `acc-carla` | -11.20 | `FARMACIA DIAGONAL 412` | `health` |
| `demo-carla-049` | 2026-10-03 18:15 | `acc-carla` | -51.20 | `BONPREU 0214 BARCELONA ES` | `groceries` |
| `demo-carla-050` | 2026-10-04 12:30 | `acc-carla` | -29.95 | `PAYPAL *ZALANDO SE 4029357733` | `shopping` |
| `demo-carla-051` | 2026-10-04 21:20 | `acc-carla` | -23.60 | `GLOVO 04OCT BCN6T1 BARCELONA` | `eating_out_leisure` |
| `demo-carla-052` | 2026-10-05 08:00 | `acc-carla` | -24.99 | `BASIC-FIT SPAIN SAU` | to review |
| `demo-carla-077` | 2026-10-05 19:30 | `acc-carla` | -62.60 | `CAPRABO 0338 BARCELONA` | `groceries` |
| `demo-carla-078` | 2026-10-06 08:10 | `acc-carla` | -4.80 | `CAFETERIA LA PLACA` | `eating_out_leisure` |

## diego

Diego Salas — `acc-diego` Horizon account, €75.00 today. 66 movements, 58 shown by rules, 8 to review.

| Id | Date, time (Madrid) | Account | Amount (EUR) | Description | By the rules (`DECIDER=none`) |
|---|---|---|---|---|---|
| `m-open-acc-diego` | 2026-07-01 08:00 | `acc-diego` | 780.86 | `Initial deposit` | `other` |
| `demo-diego-001` | 2026-07-01 12:00 | `acc-diego` | 250.00 | `BIZUM RECIBIDO DE CARMEN S. CONCEPTO MES` | `income` |
| `demo-diego-002` | 2026-07-03 09:00 | `acc-diego` | -300.00 | `TRANSFERENCIA A FAVOR DE P. MOLINA CONCEPTO ALQUILER HABITACION` | `transfer_person` |
| `demo-diego-003` | 2026-07-04 13:10 | `acc-diego` | -16.85 | `LIDL SUPERMERCADOS SAU GRANADA` | `groceries` |
| `demo-diego-004` | 2026-07-06 08:30 | `acc-diego` | -10.00 | `BONOBUS GRANADA RECARGA` | `transport` |
| `demo-diego-005` | 2026-07-08 23:05 | `acc-diego` | -74.99 | `RYANAIR 8821345567 DUBLIN IE` | `transport` |
| `demo-diego-059` | 2026-07-09 13:20 | `acc-diego` | -24.60 | `MERCADONA 0931 GRANADA` | `groceries` |
| `demo-diego-006` | 2026-07-10 08:00 | `acc-diego` | -15.00 | `RECIBO DIGI SPAIN TELECOM SLU` | `home_utilities` |
| `demo-diego-007` | 2026-07-11 02:40 | `acc-diego` | -6.50 | `KEBAB ALHAMBRA` | `eating_out_leisure` |
| `demo-diego-008` | 2026-07-12 12:20 | `acc-diego` | -40.00 | `REINTEGRO CAJERO 0118 GRANADA` | `other` |
| `demo-diego-009` | 2026-07-14 06:00 | `acc-diego` | -5.99 | `PAYPAL *SPOTIFY 35314369001` | `eating_out_leisure` |
| `demo-diego-010` | 2026-07-17 13:30 | `acc-diego` | -21.40 | `LIDL SUPERMERCADOS SAU GRANADA` | `groceries` |
| `demo-diego-011` | 2026-07-19 01:30 | `acc-diego` | -10.00 | `TPV 00931 PEDRO ANTONIO GR` | to review |
| `demo-diego-060` | 2026-07-21 19:10 | `acc-diego` | -31.85 | `MERCADONA 0931 GRANADA` | `groceries` |
| `demo-diego-012` | 2026-07-23 19:00 | `acc-diego` | -9.99 | `STEAMGAMES.COM 4259522985` | `eating_out_leisure` |
| `demo-diego-013` | 2026-07-25 22:15 | `acc-diego` | -8.00 | `BIZUM ENVIADO A NURIA V. CONCEPTO CINE` | `transfer_person` |
| `demo-diego-014` | 2026-07-28 13:05 | `acc-diego` | -14.20 | `LIDL SUPERMERCADOS SAU GRANADA` | `groceries` |
| `demo-diego-015` | 2026-07-31 08:00 | `acc-diego` | 420.00 | `NOMINA BAR EL REFUGIO SL` | `income` |
| `demo-diego-016` | 2026-08-04 12:00 | `acc-diego` | 250.00 | `BIZUM RECIBIDO DE CARMEN S. CONCEPTO MES` | `income` |
| `demo-diego-017` | 2026-08-05 09:00 | `acc-diego` | -300.00 | `TRANSFERENCIA A FAVOR DE P. MOLINA CONCEPTO ALQUILER HABITACION` | `transfer_person` |
| `demo-diego-018` | 2026-08-06 08:30 | `acc-diego` | -10.00 | `BONOBUS GRANADA RECARGA` | `transport` |
| `demo-diego-019` | 2026-08-08 13:00 | `acc-diego` | -18.40 | `LIDL SUPERMERCADOS SAU GRANADA` | `groceries` |
| `demo-diego-020` | 2026-08-10 08:00 | `acc-diego` | -15.00 | `RECIBO DIGI SPAIN TELECOM SLU` | `home_utilities` |
| `demo-diego-021` | 2026-08-12 18:40 | `acc-diego` | -29.99 | `DECATHLON GRANADA` | `shopping` |
| `demo-diego-061` | 2026-08-13 13:40 | `acc-diego` | -21.75 | `MERCADONA 0931 GRANADA` | `groceries` |
| `demo-diego-022` | 2026-08-14 06:00 | `acc-diego` | -5.99 | `PAYPAL *SPOTIFY 35314369001` | `eating_out_leisure` |
| `demo-diego-023` | 2026-08-15 03:20 | `acc-diego` | -6.50 | `KEBAB ALHAMBRA` | `eating_out_leisure` |
| `demo-diego-024` | 2026-08-18 16:00 | `acc-diego` | -19.99 | `STEAMGAMES.COM 4259522985` | `eating_out_leisure` |
| `demo-diego-025` | 2026-08-19 17:45 | `acc-diego` | -48.00 | `TICKETMASTER ES 0034912` | `eating_out_leisure` |
| `demo-diego-026` | 2026-08-20 19:15 | `acc-diego` | -11.35 | `FARMACIA RECOGIDAS 0019` | `health` |
| `demo-diego-027` | 2026-08-21 20:30 | `acc-diego` | -40.00 | `REINTEGRO CAJERO 0118 GRANADA` | `other` |
| `demo-diego-028` | 2026-08-22 01:15 | `acc-diego` | -12.00 | `TPV 00931 PEDRO ANTONIO GR` | to review |
| `demo-diego-029` | 2026-08-22 13:10 | `acc-diego` | -22.10 | `LIDL SUPERMERCADOS SAU GRANADA` | `groceries` |
| `demo-diego-030` | 2026-08-26 17:30 | `acc-diego` | -12.90 | `PRIMARK GRANADA` | `shopping` |
| `demo-diego-062` | 2026-08-27 19:20 | `acc-diego` | -26.40 | `MERCADONA 0931 GRANADA` | `groceries` |
| `demo-diego-031` | 2026-08-29 22:30 | `acc-diego` | -12.00 | `BIZUM ENVIADO A NURIA V. CONCEPTO CENA` | `transfer_person` |
| `demo-diego-032` | 2026-08-31 08:00 | `acc-diego` | 380.00 | `NOMINA BAR EL REFUGIO SL` | `income` |
| `demo-diego-033` | 2026-09-01 12:00 | `acc-diego` | 250.00 | `BIZUM RECIBIDO DE CARMEN S. CONCEPTO MES` | `income` |
| `demo-diego-034` | 2026-09-02 11:30 | `acc-diego` | -86.40 | `LIBRERIA BABEL GRANADA` | to review |
| `demo-diego-035` | 2026-09-05 04:10 | `acc-diego` | -7.00 | `KEBAB ALHAMBRA` | `eating_out_leisure` |
| `demo-diego-036` | 2026-09-05 09:00 | `acc-diego` | -300.00 | `TRANSFERENCIA A FAVOR DE P. MOLINA CONCEPTO ALQUILER HABITACION` | `transfer_person` |
| `demo-diego-037` | 2026-09-07 08:30 | `acc-diego` | -10.00 | `BONOBUS GRANADA RECARGA` | `transport` |
| `demo-diego-038` | 2026-09-08 23:10 | `acc-diego` | -13.99 | `AMZN Mktp ES*5T1BB7XK1` | to review |
| `demo-diego-039` | 2026-09-09 13:20 | `acc-diego` | -15.75 | `LIDL SUPERMERCADOS SAU GRANADA` | `groceries` |
| `demo-diego-040` | 2026-09-10 08:00 | `acc-diego` | -15.00 | `RECIBO DIGI SPAIN TELECOM SLU` | `home_utilities` |
| `demo-diego-041` | 2026-09-11 07:15 | `acc-diego` | -24.75 | `ALSA GRANADA-MADRID` | `transport` |
| `demo-diego-042` | 2026-09-12 02:30 | `acc-diego` | -9.00 | `TPV 00931 PEDRO ANTONIO GR` | to review |
| `demo-diego-043` | 2026-09-14 06:00 | `acc-diego` | -5.99 | `PAYPAL *SPOTIFY 35314369001` | `eating_out_leisure` |
| `demo-diego-063` | 2026-09-15 19:30 | `acc-diego` | -22.30 | `MERCADONA 0931 GRANADA` | `groceries` |
| `demo-diego-044` | 2026-09-16 11:00 | `acc-diego` | -4.20 | `COPISTERIA LA GIOCONDA` | to review |
| `demo-diego-045` | 2026-09-19 01:50 | `acc-diego` | -15.00 | `TPV 00931 PEDRO ANTONIO GR` | to review |
| `demo-diego-046` | 2026-09-20 18:00 | `acc-diego` | -8.00 | `BIZUM ENVIADO A ALEX T.` | `transfer_person` |
| `demo-diego-047` | 2026-09-21 21:10 | `acc-diego` | -40.00 | `REINTEGRO CAJERO 0118 GRANADA` | `other` |
| `demo-diego-048` | 2026-09-24 15:00 | `acc-diego` | 14.00 | `VINTED PAGO VENTA` | `income` |
| `demo-diego-049` | 2026-09-25 13:00 | `acc-diego` | -24.30 | `LIDL SUPERMERCADOS SAU GRANADA` | `groceries` |
| `demo-diego-050` | 2026-09-26 03:45 | `acc-diego` | -6.50 | `KEBAB ALHAMBRA` | `eating_out_leisure` |
| `demo-diego-064` | 2026-09-29 13:10 | `acc-diego` | -19.95 | `MERCADONA 0931 GRANADA` | `groceries` |
| `demo-diego-051` | 2026-09-30 08:00 | `acc-diego` | 380.00 | `NOMINA BAR EL REFUGIO SL` | `income` |
| `demo-diego-052` | 2026-10-01 08:00 | `acc-diego` | -450.00 | `UGR MATRICULA PLAZO 1` | to review |
| `demo-diego-053` | 2026-10-02 13:15 | `acc-diego` | -17.60 | `LIDL SUPERMERCADOS SAU GRANADA` | `groceries` |
| `demo-diego-054` | 2026-10-03 02:10 | `acc-diego` | -7.00 | `KEBAB ALHAMBRA` | `eating_out_leisure` |
| `demo-diego-055` | 2026-10-03 17:20 | `acc-diego` | -8.99 | `PRIMARK GRANADA` | `shopping` |
| `demo-diego-056` | 2026-10-04 08:30 | `acc-diego` | -10.00 | `BONOBUS GRANADA RECARGA` | `transport` |
| `demo-diego-057` | 2026-10-05 09:00 | `acc-diego` | -300.00 | `TRANSFERENCIA A FAVOR DE P. MOLINA CONCEPTO ALQUILER HABITACION` | `transfer_person` |
| `demo-diego-058` | 2026-10-05 10:30 | `acc-diego` | -4.95 | `FARMACIA RECOGIDAS 0019` | `health` |
| `demo-diego-065` | 2026-10-06 13:25 | `acc-diego` | -21.45 | `MERCADONA 0931 GRANADA` | `groceries` |

## elena

Elena Costa — `acc-elena-savings` Personal savings, €1,800.00 today; `acc-elena` Aurora account, €2,863.96 today. 86 movements, 79 shown by rules, 7 to review.

| Id | Date, time (Madrid) | Account | Amount (EUR) | Description | By the rules (`DECIDER=none`) |
|---|---|---|---|---|---|
| `m-open-acc-elena` | 2026-07-01 08:00 | `acc-elena` | 3,588.09 | `Initial deposit` | `other` |
| `m-open-acc-elena-savings` | 2026-07-01 08:00 | `acc-elena-savings` | 900.00 | `Initial deposit` | `other` |
| `demo-elena-001` | 2026-07-01 08:00 | `acc-elena` | -60.00 | `RECIBO COMUNIDAD PROPIETARIOS C/ OLMO 14` | `home_utilities` |
| `demo-elena-002` | 2026-07-03 18:10 | `acc-elena` | -88.75 | `EROSKI CENTER 0331 BILBAO` | `groceries` |
| `demo-elena-051` | 2026-07-04 19:30 | `acc-elena` | -31.60 | `CINESA ZUBIARTE BILBAO` | `eating_out_leisure` |
| `demo-elena-003` | 2026-07-05 08:00 | `acc-elena` | -742.18 | `RECIBO HIPOTECA 0049 KUTXABANK` | `home_utilities` |
| `demo-elena-004` | 2026-07-08 17:20 | `acc-elena` | -55.30 | `E.S. REPSOL 33412 A-8 KM 112` | `transport` |
| `demo-elena-005` | 2026-07-10 08:00 | `acc-elena` | -120.00 | `UDALEKUAK BILBAO CUOTA JULIO` | to review |
| `demo-elena-052` | 2026-07-10 18:20 | `acc-elena` | -76.40 | `BM SUPERMERCADOS 0117 BILBAO` | `groceries` |
| `demo-elena-053` | 2026-07-11 12:10 | `acc-elena` | -54.90 | `ZARA ESPANA S.A. 0611 BILBAO` | `shopping` |
| `demo-elena-006` | 2026-07-12 08:00 | `acc-elena` | -81.20 | `RECIBO IBERDROLA CLIENTES SAU` | `home_utilities` |
| `demo-elena-054` | 2026-07-15 18:40 | `acc-elena` | -21.35 | `FARMACIA ABANDO 0007` | `health` |
| `demo-elena-007` | 2026-07-17 11:40 | `acc-elena` | -97.60 | `EROSKI CENTER 0331 BILBAO` | `groceries` |
| `demo-elena-008` | 2026-07-18 21:00 | `acc-elena` | -31.50 | `TELEPIZZA BILBAO 0412` | `eating_out_leisure` |
| `demo-elena-055` | 2026-07-19 11:30 | `acc-elena` | -119.00 | `IKEA BARAKALDO` | `shopping` |
| `demo-elena-009` | 2026-07-20 08:00 | `acc-elena` | -79.90 | `MOVISTAR FUSION FACT 28-J4C9` | `home_utilities` |
| `demo-elena-010` | 2026-07-22 12:30 | `acc-elena` | -45.00 | `COMPRA TARJ. 4532XXXX DECATHLON BILBAO ES` | `shopping` |
| `demo-elena-056` | 2026-07-24 08:10 | `acc-elena` | -52.40 | `E.S. REPSOL 33412 A-8 KM 112` | `transport` |
| `demo-elena-057` | 2026-07-24 18:45 | `acc-elena` | -58.90 | `BM SUPERMERCADOS 0117 BILBAO` | `groceries` |
| `demo-elena-058` | 2026-07-25 10:05 | `acc-elena` | -9.85 | `PEAJE AP-8 ZARAUTZ` | `transport` |
| `demo-elena-011` | 2026-07-25 14:45 | `acc-elena` | -68.00 | `RESTAURANTE EL PUERTO GETXO` | `eating_out_leisure` |
| `demo-elena-012` | 2026-07-28 08:00 | `acc-elena` | 2,480.00 | `NOMINA INGENIERIA URIBE SA` | `income` |
| (transfer) | 2026-07-29 09:00 | `acc-elena` | -300.00 | `colchón` | `savings_internal` |
| (transfer) | 2026-07-29 09:00 | `acc-elena-savings` | 300.00 | `colchón` | `savings_internal` |
| `demo-elena-013` | 2026-07-31 10:20 | `acc-elena` | -84.15 | `EROSKI CENTER 0331 BILBAO` | `groceries` |
| `demo-elena-014` | 2026-08-01 08:00 | `acc-elena` | -60.00 | `RECIBO COMUNIDAD PROPIETARIOS C/ OLMO 14` | `home_utilities` |
| `demo-elena-059` | 2026-08-02 09:20 | `acc-elena` | -64.10 | `E.S. REPSOL 33412 A-8 KM 112` | `transport` |
| `demo-elena-060` | 2026-08-02 11:40 | `acc-elena` | -18.70 | `PEAJE AP-8 ZARAUTZ` | `transport` |
| `demo-elena-061` | 2026-08-04 19:10 | `acc-elena` | -88.20 | `BM SUPERMERCADOS 0117 BILBAO` | `groceries` |
| `demo-elena-015` | 2026-08-05 08:00 | `acc-elena` | -742.18 | `RECIBO HIPOTECA 0049 KUTXABANK` | `home_utilities` |
| `demo-elena-016` | 2026-08-08 18:00 | `acc-elena` | -82.40 | `EROSKI CENTER 0331 BILBAO` | `groceries` |
| `demo-elena-062` | 2026-08-09 21:30 | `acc-elena` | -84.00 | `RESTAURANTE EL PUERTO GETXO` | `eating_out_leisure` |
| `demo-elena-017` | 2026-08-12 08:00 | `acc-elena` | -88.40 | `RECIBO IBERDROLA CLIENTES SAU` | `home_utilities` |
| `demo-elena-063` | 2026-08-13 18:30 | `acc-elena` | -79.65 | `MERCADONA 5210 BARAKALDO` | `groceries` |
| `demo-elena-018` | 2026-08-14 17:30 | `acc-elena` | -62.00 | `E.S. REPSOL 33412 A-8 KM 112` | `transport` |
| `demo-elena-064` | 2026-08-15 13:40 | `acc-elena` | -23.80 | `MCDONALDS BILBAO MEGAPARK` | `eating_out_leisure` |
| `demo-elena-065` | 2026-08-18 12:20 | `acc-elena` | -39.99 | `COMPRA TARJ. 4532XXXX DECATHLON BILBAO ES` | `shopping` |
| `demo-elena-019` | 2026-08-20 08:00 | `acc-elena` | -79.90 | `MOVISTAR FUSION FACT 28-K6F1` | `home_utilities` |
| `demo-elena-020` | 2026-08-21 21:10 | `acc-elena` | -27.90 | `TELEPIZZA BILBAO 0412` | `eating_out_leisure` |
| `demo-elena-021` | 2026-08-22 11:00 | `acc-elena` | -91.15 | `EROSKI CENTER 0331 BILBAO` | `groceries` |
| `demo-elena-066` | 2026-08-24 11:15 | `acc-elena` | -62.50 | `FNAC BILBAO` | `shopping` |
| `demo-elena-022` | 2026-08-25 18:40 | `acc-elena` | -14.20 | `FARMACIA ABANDO 0007` | `health` |
| `demo-elena-067` | 2026-08-26 18:50 | `acc-elena` | -16.80 | `FARMACIA ABANDO 0007` | `health` |
| `demo-elena-023` | 2026-08-27 12:30 | `acc-elena` | -119.00 | `EL CORTE INGLES 0052 BILBAO` | to review |
| `demo-elena-024` | 2026-08-28 08:00 | `acc-elena` | 2,480.00 | `NOMINA INGENIERIA URIBE SA` | `income` |
| (transfer) | 2026-08-29 09:00 | `acc-elena` | -300.00 | `colchón` | `savings_internal` |
| (transfer) | 2026-08-29 09:00 | `acc-elena-savings` | 300.00 | `colchón` | `savings_internal` |
| `demo-elena-025` | 2026-08-29 17:00 | `acc-elena` | -63.40 | `KIABI ESPANA KSCE SA` | `shopping` |
| `demo-elena-068` | 2026-08-30 10:40 | `acc-elena` | -61.35 | `BM SUPERMERCADOS 0117 BILBAO` | `groceries` |
| `demo-elena-026` | 2026-09-01 08:00 | `acc-elena` | -60.00 | `RECIBO COMUNIDAD PROPIETARIOS C/ OLMO 14` | `home_utilities` |
| `demo-elena-027` | 2026-09-02 08:00 | `acc-elena` | -48.00 | `MAPFRE RECIBO POLIZA 55120` | to review |
| `demo-elena-069` | 2026-09-03 17:40 | `acc-elena` | -74.35 | `CASA DEL LIBRO BILBAO` | `shopping` |
| `demo-elena-028` | 2026-09-03 19:00 | `acc-elena` | -35.98 | `COMPRA TARJ. 4532XXXX DECATHLON BILBAO ES` | `shopping` |
| `demo-elena-029` | 2026-09-05 08:00 | `acc-elena` | -742.18 | `RECIBO HIPOTECA 0049 KUTXABANK` | `home_utilities` |
| `demo-elena-030` | 2026-09-05 18:20 | `acc-elena` | -76.30 | `EROSKI CENTER 0331 BILBAO` | `groceries` |
| `demo-elena-070` | 2026-09-06 13:30 | `acc-elena` | -19.40 | `MCDONALDS BILBAO MEGAPARK` | `eating_out_leisure` |
| `demo-elena-031` | 2026-09-08 22:15 | `acc-elena` | -32.99 | `AMZN Mktp ES*8M3DD2WQ7` | to review |
| `demo-elena-032` | 2026-09-10 08:00 | `acc-elena` | -95.00 | `COLEGIO LAS ARENAS CUOTA COMEDOR` | to review |
| `demo-elena-071` | 2026-09-10 18:30 | `acc-elena` | -82.75 | `BM SUPERMERCADOS 0117 BILBAO` | `groceries` |
| `demo-elena-033` | 2026-09-12 08:00 | `acc-elena` | -93.15 | `RECIBO IBERDROLA CLIENTES SAU` | `home_utilities` |
| `demo-elena-072` | 2026-09-12 12:15 | `acc-elena` | -68.70 | `KIABI ESPANA KSCE SA` | `shopping` |
| `demo-elena-034` | 2026-09-13 17:10 | `acc-elena` | -58.40 | `E.S. REPSOL 33412 A-8 KM 112` | `transport` |
| `demo-elena-073` | 2026-09-14 14:30 | `acc-elena` | -62.00 | `RESTAURANTE EL PUERTO GETXO` | `eating_out_leisure` |
| `demo-elena-035` | 2026-09-15 08:00 | `acc-elena` | -30.00 | `EXTRAESCOLARES JUDO CLUB TXIKI` | to review |
| `demo-elena-036` | 2026-09-17 17:00 | `acc-elena` | -90.00 | `CLINICA DENTAL SONRISA SLP` | `health` |
| `demo-elena-037` | 2026-09-17 18:10 | `acc-elena` | -6.40 | `TELPARK INDAUTXU` | `transport` |
| `demo-elena-038` | 2026-09-19 11:20 | `acc-elena` | -104.80 | `EROSKI CENTER 0331 BILBAO` | `groceries` |
| `demo-elena-039` | 2026-09-20 08:00 | `acc-elena` | -79.90 | `MOVISTAR FUSION FACT 28-L2B7` | `home_utilities` |
| (transfer) | 2026-09-23 18:42 | `acc-elena` | -25.00 | `Transfer · Transfer to Hugo` | `transfer_person` |
| `demo-elena-074` | 2026-09-24 18:40 | `acc-elena` | -68.40 | `MERCADONA 5210 BARAKALDO` | `groceries` |
| `demo-elena-040` | 2026-09-25 21:20 | `acc-elena` | -24.50 | `TELEPIZZA BILBAO 0412` | `eating_out_leisure` |
| `demo-elena-075` | 2026-09-27 09:15 | `acc-elena` | -55.60 | `E.S. REPSOL 33412 A-8 KM 112` | `transport` |
| `demo-elena-041` | 2026-09-27 12:10 | `acc-elena` | -18.60 | `FARMACIA ABANDO 0007` | `health` |
| `demo-elena-042` | 2026-09-28 08:00 | `acc-elena` | 2,480.00 | `NOMINA INGENIERIA URIBE SA` | `income` |
| (transfer) | 2026-09-29 09:00 | `acc-elena` | -300.00 | `colchón` | `savings_internal` |
| (transfer) | 2026-09-29 09:00 | `acc-elena-savings` | 300.00 | `colchón` | `savings_internal` |
| `demo-elena-076` | 2026-09-29 19:05 | `acc-elena` | -59.90 | `BM SUPERMERCADOS 0117 BILBAO` | `groceries` |
| `demo-elena-043` | 2026-10-01 08:00 | `acc-elena` | -60.00 | `RECIBO COMUNIDAD PROPIETARIOS C/ OLMO 14` | `home_utilities` |
| `demo-elena-044` | 2026-10-01 08:05 | `acc-elena` | -95.00 | `COLEGIO LAS ARENAS CUOTA COMEDOR` | to review |
| `demo-elena-045` | 2026-10-02 21:05 | `acc-elena` | -26.40 | `TELEPIZZA BILBAO 0412` | `eating_out_leisure` |
| `demo-elena-046` | 2026-10-03 12:10 | `acc-elena` | -42.90 | `KIABI ESPANA KSCE SA` | `shopping` |
| `demo-elena-047` | 2026-10-03 18:30 | `acc-elena` | -92.35 | `EROSKI CENTER 0331 BILBAO` | `groceries` |
| `demo-elena-048` | 2026-10-04 11:30 | `acc-elena` | -12.75 | `FARMACIA ABANDO 0007` | `health` |
| `demo-elena-049` | 2026-10-04 17:05 | `acc-elena` | -61.20 | `E.S. REPSOL 33412 A-8 KM 112` | `transport` |
| `demo-elena-050` | 2026-10-05 08:00 | `acc-elena` | -742.18 | `RECIBO HIPOTECA 0049 KUTXABANK` | `home_utilities` |
| `demo-elena-077` | 2026-10-06 18:40 | `acc-elena` | -71.45 | `BM SUPERMERCADOS 0117 BILBAO` | `groceries` |

## hugo

Hugo Pérez — `acc-hugo` Horizon account, €3,472.12 today. 78 movements, 71 shown by rules, 7 to review.

| Id | Date, time (Madrid) | Account | Amount (EUR) | Description | By the rules (`DECIDER=none`) |
|---|---|---|---|---|---|
| `m-open-acc-hugo` | 2026-07-01 08:00 | `acc-hugo` | 1,802.34 | `Initial deposit` | `other` |
| (transfer) | 2026-07-01 09:00 | `acc-hugo` | -400.00 | `Transfer · alquiler julio` | `transfer_person` |
| `demo-hugo-001` | 2026-07-03 08:00 | `acc-hugo` | 330.00 | `NOMINA SEMANAL TEMPOLOG ETT SA` | `income` |
| `demo-hugo-002` | 2026-07-03 19:20 | `acc-hugo` | -27.90 | `MERCADONA 2231 SEVILLA` | `groceries` |
| `demo-hugo-003` | 2026-07-05 08:30 | `acc-hugo` | -19.00 | `CEPSA E.S. LA CARTUJA` | `transport` |
| `demo-hugo-059` | 2026-07-08 19:30 | `acc-hugo` | -41.30 | `LIDL SUPERMERCADOS SAU SEVILLA` | `groceries` |
| `demo-hugo-004` | 2026-07-10 06:00 | `acc-hugo` | -29.90 | `VIDING FITNESS SEVILLA` | to review |
| `demo-hugo-005` | 2026-07-10 08:00 | `acc-hugo` | 330.00 | `NOMINA SEMANAL TEMPOLOG ETT SA` | `income` |
| `demo-hugo-006` | 2026-07-11 21:20 | `acc-hugo` | -11.00 | `100 MONTADITOS 0456 SEVILLA` | `eating_out_leisure` |
| `demo-hugo-060` | 2026-07-13 11:20 | `acc-hugo` | -79.00 | `MEDIAMARKT SEVILLA LAGOH` | `shopping` |
| `demo-hugo-061` | 2026-07-14 09:30 | `acc-hugo` | -34.90 | `ITV SEVILLA NORTE` | `transport` |
| `demo-hugo-007` | 2026-07-17 08:00 | `acc-hugo` | 330.00 | `NOMINA SEMANAL TEMPOLOG ETT SA` | `income` |
| `demo-hugo-008` | 2026-07-17 19:10 | `acc-hugo` | -33.45 | `MERCADONA 2231 SEVILLA` | `groceries` |
| `demo-hugo-009` | 2026-07-18 08:00 | `acc-hugo` | -22.00 | `YOIGO RECIBO` | `home_utilities` |
| `demo-hugo-010` | 2026-07-19 20:30 | `acc-hugo` | -15.00 | `BIZUM ENVIADO A RAFA M.` | `transfer_person` |
| `demo-hugo-011` | 2026-07-22 08:10 | `acc-hugo` | -18.50 | `CEPSA E.S. LA CARTUJA` | `transport` |
| `demo-hugo-062` | 2026-07-23 19:15 | `acc-hugo` | -47.85 | `MERCADONA 2231 SEVILLA` | `groceries` |
| `demo-hugo-012` | 2026-07-24 08:00 | `acc-hugo` | 330.00 | `NOMINA SEMANAL TEMPOLOG ETT SA` | `income` |
| `demo-hugo-013` | 2026-07-25 22:00 | `acc-hugo` | -9.00 | `100 MONTADITOS 0456 SEVILLA` | `eating_out_leisure` |
| `demo-hugo-014` | 2026-07-26 12:00 | `acc-hugo` | -45.00 | `DECATHLON SEVILLA` | `shopping` |
| `demo-hugo-063` | 2026-07-27 18:40 | `acc-hugo` | -8.40 | `FARMACIA TRIANA 0112` | `health` |
| `demo-hugo-064` | 2026-07-28 19:50 | `acc-hugo` | -36.20 | `LIDL SUPERMERCADOS SAU SEVILLA` | `groceries` |
| `demo-hugo-015` | 2026-07-31 08:00 | `acc-hugo` | 330.00 | `NOMINA SEMANAL TEMPOLOG ETT SA` | `income` |
| `demo-hugo-016` | 2026-07-31 19:15 | `acc-hugo` | -30.10 | `MERCADONA 2231 SEVILLA` | `groceries` |
| `demo-hugo-065` | 2026-08-01 19:20 | `acc-hugo` | -52.40 | `MERCADONA 2231 SEVILLA` | `groceries` |
| (transfer) | 2026-08-04 09:00 | `acc-hugo` | -400.00 | `Transfer · alquiler agosto` | `transfer_person` |
| `demo-hugo-017` | 2026-08-07 08:00 | `acc-hugo` | 330.00 | `NOMINA SEMANAL TEMPOLOG ETT SA` | `income` |
| `demo-hugo-018` | 2026-08-07 19:10 | `acc-hugo` | -31.20 | `MERCADONA 2231 SEVILLA` | `groceries` |
| `demo-hugo-019` | 2026-08-08 08:00 | `acc-hugo` | -41.20 | `RECIBO SEGURO MOTO LINEA DIRECTA` | `transport` |
| `demo-hugo-020` | 2026-08-09 08:20 | `acc-hugo` | -18.00 | `CEPSA E.S. LA CARTUJA` | `transport` |
| `demo-hugo-021` | 2026-08-10 06:00 | `acc-hugo` | -29.90 | `VIDING FITNESS SEVILLA` | to review |
| `demo-hugo-022` | 2026-08-12 21:00 | `acc-hugo` | -9.50 | `100 MONTADITOS 0456 SEVILLA` | `eating_out_leisure` |
| `demo-hugo-023` | 2026-08-14 08:00 | `acc-hugo` | 330.00 | `NOMINA SEMANAL TEMPOLOG ETT SA` | `income` |
| `demo-hugo-066` | 2026-08-14 19:40 | `acc-hugo` | -44.75 | `LIDL SUPERMERCADOS SAU SEVILLA` | `groceries` |
| `demo-hugo-067` | 2026-08-16 12:30 | `acc-hugo` | -27.50 | `PRIMARK SEVILLA` | `shopping` |
| `demo-hugo-024` | 2026-08-18 08:00 | `acc-hugo` | -22.00 | `YOIGO RECIBO` | `home_utilities` |
| `demo-hugo-025` | 2026-08-19 23:40 | `acc-hugo` | -15.99 | `AMZN Mktp ES*3C8VV5NN2` | to review |
| `demo-hugo-026` | 2026-08-21 08:00 | `acc-hugo` | 330.00 | `NOMINA SEMANAL TEMPOLOG ETT SA` | `income` |
| `demo-hugo-027` | 2026-08-21 19:30 | `acc-hugo` | -28.75 | `MERCADONA 2231 SEVILLA` | `groceries` |
| `demo-hugo-028` | 2026-08-23 20:00 | `acc-hugo` | -20.00 | `BIZUM ENVIADO A RAFA M.` | `transfer_person` |
| `demo-hugo-029` | 2026-08-24 08:10 | `acc-hugo` | -19.50 | `CEPSA E.S. LA CARTUJA` | `transport` |
| `demo-hugo-030` | 2026-08-27 12:00 | `acc-hugo` | -37.50 | `WALLAPOP *ENVIO 99120` | `shopping` |
| `demo-hugo-031` | 2026-08-28 08:00 | `acc-hugo` | 330.00 | `NOMINA SEMANAL TEMPOLOG ETT SA` | `income` |
| `demo-hugo-068` | 2026-08-28 19:10 | `acc-hugo` | -58.10 | `MERCADONA 2231 SEVILLA` | `groceries` |
| `demo-hugo-032` | 2026-08-30 02:14 | `acc-hugo` | -22.00 | `TPV SALA MALANDAR 02:14` | to review |
| (transfer) | 2026-09-01 09:00 | `acc-hugo` | -400.00 | `Transfer · alquiler septiembre` | `transfer_person` |
| `demo-hugo-069` | 2026-09-03 19:15 | `acc-hugo` | -49.90 | `MERCADONA 2231 SEVILLA` | `groceries` |
| `demo-hugo-033` | 2026-09-04 08:00 | `acc-hugo` | 330.00 | `NOMINA SEMANAL TEMPOLOG ETT SA` | `income` |
| `demo-hugo-034` | 2026-09-04 20:00 | `acc-hugo` | -40.00 | `REINTEGRO CAJERO 0331 SEVILLA` | `other` |
| `demo-hugo-035` | 2026-09-06 12:30 | `acc-hugo` | -24.99 | `DECATHLON SEVILLA` | `shopping` |
| `demo-hugo-036` | 2026-09-08 18:30 | `acc-hugo` | -12.80 | `COMPRA EN DIA % S.A. 08-09 TARJ *7781` | `groceries` |
| `demo-hugo-037` | 2026-09-09 08:15 | `acc-hugo` | -20.00 | `CEPSA E.S. LA CARTUJA` | `transport` |
| `demo-hugo-038` | 2026-09-10 06:00 | `acc-hugo` | -29.90 | `VIDING FITNESS SEVILLA` | to review |
| `demo-hugo-039` | 2026-09-11 08:00 | `acc-hugo` | 330.00 | `NOMINA SEMANAL TEMPOLOG ETT SA` | `income` |
| `demo-hugo-070` | 2026-09-12 19:30 | `acc-hugo` | -55.35 | `LIDL SUPERMERCADOS SAU SEVILLA` | `groceries` |
| `demo-hugo-040` | 2026-09-13 21:30 | `acc-hugo` | -10.00 | `BIZUM ENVIADO A RAFA M.` | `transfer_person` |
| `demo-hugo-041` | 2026-09-13 21:45 | `acc-hugo` | -12.00 | `100 MONTADITOS 0456 SEVILLA` | `eating_out_leisure` |
| `demo-hugo-042` | 2026-09-16 08:00 | `acc-hugo` | -90.00 | `MULTA AYTO SEVILLA EXP 2026/0091` | `other` |
| `demo-hugo-043` | 2026-09-18 08:00 | `acc-hugo` | -22.00 | `YOIGO RECIBO` | `home_utilities` |
| `demo-hugo-044` | 2026-09-18 08:00 | `acc-hugo` | 330.00 | `NOMINA SEMANAL TEMPOLOG ETT SA` | `income` |
| `demo-hugo-045` | 2026-09-19 19:00 | `acc-hugo` | -35.60 | `MERCADONA 2231 SEVILLA` | `groceries` |
| `demo-hugo-046` | 2026-09-22 22:50 | `acc-hugo` | -29.90 | `AMZN Mktp ES*6R0JJ9TT4` | to review |
| (transfer) | 2026-09-23 18:42 | `acc-hugo` | 25.00 | `Transfer · Transfer to Hugo` | `income` |
| `demo-hugo-047` | 2026-09-24 19:00 | `acc-hugo` | -40.00 | `FISIOTERAPIA AVANZA SL` | `health` |
| `demo-hugo-048` | 2026-09-25 08:00 | `acc-hugo` | 330.00 | `NOMINA SEMANAL TEMPOLOG ETT SA` | `income` |
| `demo-hugo-049` | 2026-09-26 10:00 | `acc-hugo` | -60.00 | `TRANSFERENCIA 000987` | to review |
| `demo-hugo-071` | 2026-09-26 19:20 | `acc-hugo` | -53.80 | `MERCADONA 2231 SEVILLA` | `groceries` |
| `demo-hugo-050` | 2026-09-27 21:10 | `acc-hugo` | -8.50 | `100 MONTADITOS 0456 SEVILLA` | `eating_out_leisure` |
| `demo-hugo-051` | 2026-09-29 08:10 | `acc-hugo` | -17.50 | `CEPSA E.S. LA CARTUJA` | `transport` |
| `demo-hugo-052` | 2026-10-02 08:00 | `acc-hugo` | 330.00 | `NOMINA SEMANAL TEMPOLOG ETT SA` | `income` |
| `demo-hugo-053` | 2026-10-02 19:05 | `acc-hugo` | -32.80 | `MERCADONA 2231 SEVILLA` | `groceries` |
| `demo-hugo-054` | 2026-10-03 11:30 | `acc-hugo` | -19.99 | `DECATHLON SEVILLA` | `shopping` |
| `demo-hugo-055` | 2026-10-03 21:15 | `acc-hugo` | -10.50 | `100 MONTADITOS 0456 SEVILLA` | `eating_out_leisure` |
| `demo-hugo-056` | 2026-10-04 08:20 | `acc-hugo` | -20.00 | `CEPSA E.S. LA CARTUJA` | `transport` |
| `demo-hugo-057` | 2026-10-04 20:10 | `acc-hugo` | -10.00 | `BIZUM ENVIADO A RAFA M.` | `transfer_person` |
| `demo-hugo-058` | 2026-10-05 18:00 | `acc-hugo` | -40.00 | `FISIOTERAPIA AVANZA SL` | `health` |
| `demo-hugo-072` | 2026-10-05 19:40 | `acc-hugo` | -28.60 | `LIDL SUPERMERCADOS SAU SEVILLA` | `groceries` |
| `demo-hugo-073` | 2026-10-06 18:30 | `acc-hugo` | -14.30 | `COMPRA EN DIA % S.A. 06-10 TARJ *7781` | `groceries` |

## ines

Inés López — `acc-ines-savings` Personal savings, €1,200.00 today; `acc-ines` Aurora account, €4,832.85 today. 81 movements, 75 shown by rules, 6 to review.

| Id | Date, time (Madrid) | Account | Amount (EUR) | Description | By the rules (`DECIDER=none`) |
|---|---|---|---|---|---|
| `m-open-acc-ines` | 2026-07-01 08:00 | `acc-ines` | 4,007.30 | `Initial deposit` | `other` |
| `m-open-acc-ines-savings` | 2026-07-01 08:00 | `acc-ines-savings` | 900.00 | `Initial deposit` | `other` |
| `demo-ines-001` | 2026-07-01 08:00 | `acc-ines` | -55.00 | `RECIBO COMUNIDAD PROPIETARIOS PS SAGASTA 9` | `home_utilities` |
| `demo-ines-002` | 2026-07-03 08:00 | `acc-ines` | -52.00 | `SANITAS S.A. DE SEGUROS RECIBO` | `health` |
| `demo-ines-003` | 2026-07-04 10:20 | `acc-ines` | -36.75 | `MERCADONA 0877 ZARAGOZA` | `groceries` |
| `demo-ines-004` | 2026-07-07 10:05 | `acc-ines` | -7.20 | `FRUTERIA HNOS GARCIA` | `groceries` |
| `demo-ines-059` | 2026-07-08 10:30 | `acc-ines` | -28.40 | `CARNICERIA HNOS LAHOZ` | `groceries` |
| `demo-ines-005` | 2026-07-09 11:10 | `acc-ines` | -3.60 | `CAFETERIA EL TUBO` | `eating_out_leisure` |
| `demo-ines-006` | 2026-07-10 08:00 | `acc-ines` | -10.00 | `DONATIVO CRUZ ROJA ESPANOLA` | `other` |
| `demo-ines-060` | 2026-07-11 10:15 | `acc-ines` | -78.90 | `ALCAMPO ZARAGOZA UTEBO` | `groceries` |
| `demo-ines-061` | 2026-07-12 14:10 | `acc-ines` | -32.00 | `RESTAURANTE LA RINCONADA DE LORENZO` | `eating_out_leisure` |
| `demo-ines-007` | 2026-07-14 08:00 | `acc-ines` | -27.60 | `NATURGY IBERIA SA GAS` | `home_utilities` |
| `demo-ines-008` | 2026-07-15 18:00 | `acc-ines` | -15.30 | `FARMACIA LDA. M. RUIZ 0001` | `health` |
| `demo-ines-009` | 2026-07-18 10:30 | `acc-ines` | -42.10 | `MERCADONA 0877 ZARAGOZA` | `groceries` |
| `demo-ines-010` | 2026-07-21 09:15 | `acc-ines` | -3.20 | `PANADERIA LA TAHONA SL` | `groceries` |
| `demo-ines-011` | 2026-07-23 17:00 | `acc-ines` | -28.00 | `PELUQUERIA MARISOL` | to review |
| `demo-ines-012` | 2026-07-24 08:00 | `acc-ines` | 1,340.00 | `ABONO PENSION SEGURIDAD SOCIAL` | `income` |
| `demo-ines-062` | 2026-07-25 10:20 | `acc-ines` | -61.20 | `MERCADONA 0877 ZARAGOZA` | `groceries` |
| (transfer) | 2026-07-27 09:30 | `acc-ines` | -150.00 | `viaje imserso` | `savings_internal` |
| (transfer) | 2026-07-27 09:30 | `acc-ines-savings` | 150.00 | `viaje imserso` | `savings_internal` |
| `demo-ines-013` | 2026-07-27 11:00 | `acc-ines` | -150.00 | `REINTEGRO CAJERO 0412 ZARAGOZA` | `other` |
| `demo-ines-014` | 2026-07-29 12:00 | `acc-ines` | -20.00 | `BIZUM ENVIADO A NIETO PABLO CONCEPTO PAGA` | `transfer_person` |
| `demo-ines-063` | 2026-07-30 10:35 | `acc-ines` | -62.80 | `ALCAMPO ZARAGOZA UTEBO` | `groceries` |
| `demo-ines-015` | 2026-08-01 08:00 | `acc-ines` | -55.00 | `RECIBO COMUNIDAD PROPIETARIOS PS SAGASTA 9` | `home_utilities` |
| `demo-ines-064` | 2026-08-03 10:30 | `acc-ines` | -74.60 | `ALCAMPO ZARAGOZA UTEBO` | `groceries` |
| `demo-ines-016` | 2026-08-04 08:00 | `acc-ines` | -52.00 | `SANITAS S.A. DE SEGUROS RECIBO` | `health` |
| `demo-ines-017` | 2026-08-06 10:15 | `acc-ines` | -34.60 | `MERCADONA 0877 ZARAGOZA` | `groceries` |
| `demo-ines-018` | 2026-08-07 08:00 | `acc-ines` | -41.80 | `ADEUDO RECIBO ENDESA ENERGIA XXI SLU REF 0077309` | `home_utilities` |
| `demo-ines-019` | 2026-08-08 10:10 | `acc-ines` | -6.30 | `FRUTERIA HNOS GARCIA` | `groceries` |
| `demo-ines-020` | 2026-08-10 08:00 | `acc-ines` | -10.00 | `DONATIVO CRUZ ROJA ESPANOLA` | `other` |
| `demo-ines-021` | 2026-08-13 18:20 | `acc-ines` | -12.45 | `FARMACIA LDA. M. RUIZ 0001` | `health` |
| `demo-ines-022` | 2026-08-14 08:00 | `acc-ines` | -29.90 | `NATURGY IBERIA SA GAS` | `home_utilities` |
| `demo-ines-065` | 2026-08-17 10:20 | `acc-ines` | -66.30 | `ALCAMPO ZARAGOZA UTEBO` | `groceries` |
| `demo-ines-023` | 2026-08-18 12:30 | `acc-ines` | -129.00 | `OPTICA UNIVERSITARIA 0034` | `health` |
| `demo-ines-066` | 2026-08-19 10:40 | `acc-ines` | -26.85 | `CARNICERIA HNOS LAHOZ` | `groceries` |
| `demo-ines-024` | 2026-08-20 10:20 | `acc-ines` | -41.20 | `MERCADONA 0877 ZARAGOZA` | `groceries` |
| `demo-ines-025` | 2026-08-20 12:40 | `acc-ines` | -64.00 | `EL CORTE INGLES 0007 ZARAGOZA` | to review |
| `demo-ines-026` | 2026-08-22 09:10 | `acc-ines` | -3.20 | `PANADERIA LA TAHONA SL` | `groceries` |
| `demo-ines-067` | 2026-08-22 14:20 | `acc-ines` | -28.50 | `RESTAURANTE LA RINCONADA DE LORENZO` | `eating_out_leisure` |
| `demo-ines-027` | 2026-08-25 08:00 | `acc-ines` | 1,340.00 | `ABONO PENSION SEGURIDAD SOCIAL` | `income` |
| `demo-ines-028` | 2026-08-26 11:00 | `acc-ines` | -150.00 | `REINTEGRO CAJERO 0412 ZARAGOZA` | `other` |
| `demo-ines-029` | 2026-08-27 17:00 | `acc-ines` | -28.00 | `PELUQUERIA MARISOL` | to review |
| `demo-ines-068` | 2026-08-28 10:25 | `acc-ines` | -68.75 | `MERCADONA 0877 ZARAGOZA` | `groceries` |
| `demo-ines-030` | 2026-08-30 12:00 | `acc-ines` | -20.00 | `BIZUM ENVIADO A NIETO PABLO CONCEPTO PAGA` | `transfer_person` |
| `demo-ines-031` | 2026-09-01 08:00 | `acc-ines` | -55.00 | `RECIBO COMUNIDAD PROPIETARIOS PS SAGASTA 9` | `home_utilities` |
| `demo-ines-032` | 2026-09-03 08:00 | `acc-ines` | -52.00 | `SANITAS S.A. DE SEGUROS RECIBO` | `health` |
| `demo-ines-033` | 2026-09-03 10:30 | `acc-ines` | -38.90 | `MERCADONA 0877 ZARAGOZA` | `groceries` |
| `demo-ines-034` | 2026-09-05 10:05 | `acc-ines` | -8.10 | `FRUTERIA HNOS GARCIA` | `groceries` |
| `demo-ines-069` | 2026-09-05 14:15 | `acc-ines` | -34.00 | `RESTAURANTE LA RINCONADA DE LORENZO` | `eating_out_leisure` |
| `demo-ines-035` | 2026-09-06 11:00 | `acc-ines` | -3.60 | `CAFETERIA EL TUBO` | `eating_out_leisure` |
| `demo-ines-036` | 2026-09-07 08:00 | `acc-ines` | -44.00 | `ADEUDO RECIBO ENDESA ENERGIA XXI SLU REF 0077310` | `home_utilities` |
| `demo-ines-037` | 2026-09-09 13:15 | `acc-ines` | -8.70 | `TAXI ZGZ LIC 0412` | `transport` |
| `demo-ines-038` | 2026-09-10 08:00 | `acc-ines` | -10.00 | `DONATIVO CRUZ ROJA ESPANOLA` | `other` |
| `demo-ines-070` | 2026-09-10 10:35 | `acc-ines` | -72.40 | `ALCAMPO ZARAGOZA UTEBO` | `groceries` |
| `demo-ines-039` | 2026-09-11 12:00 | `acc-ines` | -20.00 | `LOTERIAS Y APUESTAS DEL ESTADO 50012` | to review |
| `demo-ines-071` | 2026-09-12 10:45 | `acc-ines` | -24.60 | `CARNICERIA HNOS LAHOZ` | `groceries` |
| `demo-ines-040` | 2026-09-14 08:00 | `acc-ines` | -31.40 | `NATURGY IBERIA SA GAS` | `home_utilities` |
| `demo-ines-041` | 2026-09-16 18:10 | `acc-ines` | -23.80 | `FARMACIA LDA. M. RUIZ 0001` | `health` |
| `demo-ines-042` | 2026-09-17 10:40 | `acc-ines` | -45.30 | `MERCADONA 0877 ZARAGOZA` | `groceries` |
| `demo-ines-043` | 2026-09-18 09:00 | `acc-ines` | -31.80 | `RENFE VIAJEROS INTERNET MADRID` | `transport` |
| `demo-ines-044` | 2026-09-18 13:00 | `acc-ines` | -112.50 | `EL CORTE INGLES 0007 ZARAGOZA` | to review |
| `demo-ines-045` | 2026-09-19 10:00 | `acc-ines` | -5.75 | `FRUTERIA HNOS GARCIA` | `groceries` |
| `demo-ines-046` | 2026-09-20 11:10 | `acc-ines` | -4.10 | `CAFETERIA EL TUBO` | `eating_out_leisure` |
| `demo-ines-072` | 2026-09-23 10:30 | `acc-ines` | -64.85 | `ALCAMPO ZARAGOZA UTEBO` | `groceries` |
| `demo-ines-047` | 2026-09-24 17:00 | `acc-ines` | -28.00 | `PELUQUERIA MARISOL` | to review |
| `demo-ines-048` | 2026-09-25 08:00 | `acc-ines` | 1,340.00 | `ABONO PENSION SEGURIDAD SOCIAL` | `income` |
| (transfer) | 2026-09-26 09:30 | `acc-ines` | -150.00 | `viaje imserso` | `savings_internal` |
| (transfer) | 2026-09-26 09:30 | `acc-ines-savings` | 150.00 | `viaje imserso` | `savings_internal` |
| `demo-ines-049` | 2026-09-26 11:00 | `acc-ines` | -150.00 | `REINTEGRO CAJERO 0412 ZARAGOZA` | `other` |
| `demo-ines-050` | 2026-09-27 12:00 | `acc-ines` | -20.00 | `BIZUM ENVIADO A NIETO PABLO CONCEPTO PAGA` | `transfer_person` |
| `demo-ines-073` | 2026-09-28 10:20 | `acc-ines` | -67.30 | `MERCADONA 0877 ZARAGOZA` | `groceries` |
| `demo-ines-051` | 2026-09-29 18:00 | `acc-ines` | -9.10 | `FARMACIA LDA. M. RUIZ 0001` | `health` |
| `demo-ines-052` | 2026-10-01 08:00 | `acc-ines` | -55.00 | `RECIBO COMUNIDAD PROPIETARIOS PS SAGASTA 9` | `home_utilities` |
| `demo-ines-053` | 2026-10-02 09:20 | `acc-ines` | -8.40 | `TAXI ZGZ LIC 0412` | `transport` |
| `demo-ines-054` | 2026-10-02 10:25 | `acc-ines` | -39.40 | `MERCADONA 0877 ZARAGOZA` | `groceries` |
| `demo-ines-055` | 2026-10-03 08:00 | `acc-ines` | -52.00 | `SANITAS S.A. DE SEGUROS RECIBO` | `health` |
| `demo-ines-056` | 2026-10-03 10:10 | `acc-ines` | -6.90 | `FRUTERIA HNOS GARCIA` | `groceries` |
| `demo-ines-057` | 2026-10-04 11:05 | `acc-ines` | -3.60 | `CAFETERIA EL TUBO` | `eating_out_leisure` |
| `demo-ines-074` | 2026-10-05 10:30 | `acc-ines` | -22.90 | `CARNICERIA HNOS LAHOZ` | `groceries` |
| `demo-ines-058` | 2026-10-05 11:30 | `acc-ines` | -25.95 | `ZARA ESPANA S.A. 0412 ZARAGOZA` | `shopping` |
| `demo-ines-075` | 2026-10-06 10:40 | `acc-ines` | -58.60 | `ALCAMPO ZARAGOZA UTEBO` | `groceries` |

## omar

Omar León — `acc-omar` Horizon account, €6,160.22 today. 82 movements, 75 shown by rules, 7 to review.

| Id | Date, time (Madrid) | Account | Amount (EUR) | Description | By the rules (`DECIDER=none`) |
|---|---|---|---|---|---|
| `m-open-acc-omar` | 2026-07-01 08:00 | `acc-omar` | 4,491.98 | `Initial deposit` | `other` |
| (transfer) | 2026-07-01 09:00 | `acc-omar` | 400.00 | `Transfer · alquiler julio` | `income` |
| `demo-omar-051` | 2026-07-01 19:30 | `acc-omar` | -72.40 | `MERCADONA 1904 MALAGA` | `groceries` |
| `demo-omar-001` | 2026-07-03 08:00 | `acc-omar` | -1,100.00 | `RECIBO ALQUILER COSTA PROPERTIES SL` | `home_utilities` |
| `demo-omar-002` | 2026-07-04 20:15 | `acc-omar` | -28.60 | `CARREFOUR EXPRESS 1182 MALAGA ESP` | `groceries` |
| `demo-omar-052` | 2026-07-06 12:20 | `acc-omar` | -189.00 | `MEDIAMARKT MALAGA PLAZA MAYOR` | `shopping` |
| `demo-omar-053` | 2026-07-08 23:50 | `acc-omar` | -14.80 | `CABIFY ESPANA SLU` | `transport` |
| `demo-omar-003` | 2026-07-09 06:00 | `acc-omar` | -13.99 | `NETFLIX.COM AMSTERDAM NL` | `eating_out_leisure` |
| `demo-omar-054` | 2026-07-10 19:10 | `acc-omar` | -58.90 | `LIDL SUPERMERCADOS SAU MALAGA` | `groceries` |
| `demo-omar-004` | 2026-07-11 06:00 | `acc-omar` | -9.25 | `GITHUB, INC. SAN FRANCISCO US` | `work` |
| `demo-omar-005` | 2026-07-12 21:30 | `acc-omar` | -19.80 | `UBER *EATS PENDING AMSTERDAM` | `eating_out_leisure` |
| `demo-omar-055` | 2026-07-13 17:30 | `acc-omar` | -75.00 | `CLINICA DENTAL MALAGA CENTRO SLP` | `health` |
| `demo-omar-056` | 2026-07-15 22:05 | `acc-omar` | -96.40 | `VUELING AIRLINES BCN` | `transport` |
| `demo-omar-006` | 2026-07-16 08:00 | `acc-omar` | -64.10 | `TOTALENERGIES CLIENTES SAU` | `home_utilities` |
| `demo-omar-057` | 2026-07-17 19:40 | `acc-omar` | -81.35 | `MERCADONA 1904 MALAGA` | `groceries` |
| `demo-omar-007` | 2026-07-18 20:40 | `acc-omar` | -46.50 | `RESTAURANTE CASA PACO S.L.` | `eating_out_leisure` |
| `demo-omar-008` | 2026-07-19 09:10 | `acc-omar` | -42.10 | `RENFE VIAJEROS INTERNET MADRID` | `transport` |
| `demo-omar-058` | 2026-07-21 12:10 | `acc-omar` | -64.99 | `DECATHLON MALAGA` | `shopping` |
| `demo-omar-009` | 2026-07-22 08:00 | `acc-omar` | -38.00 | `O2 FIBRA RECIBO` | `home_utilities` |
| `demo-omar-010` | 2026-07-24 19:25 | `acc-omar` | -35.20 | `CARREFOUR EXPRESS 1182 MALAGA ESP` | `groceries` |
| `demo-omar-059` | 2026-07-26 18:20 | `acc-omar` | -79.90 | `ZARA ESPANA S.A. 0207 MALAGA` | `shopping` |
| `demo-omar-011` | 2026-07-27 07:00 | `acc-omar` | 2,900.00 | `PAYROLL JUL - GLOBEX EU BV` | `income` |
| `demo-omar-060` | 2026-07-29 19:15 | `acc-omar` | -54.60 | `MERCADONA 1904 MALAGA` | `groceries` |
| `demo-omar-012` | 2026-07-30 22:40 | `acc-omar` | -17.30 | `UBER *EATS PENDING AMSTERDAM` | `eating_out_leisure` |
| `demo-omar-061` | 2026-08-02 11:30 | `acc-omar` | -68.20 | `MERCADONA 1904 MALAGA` | `groceries` |
| `demo-omar-013` | 2026-08-04 08:00 | `acc-omar` | -1,100.00 | `RECIBO ALQUILER COSTA PROPERTIES SL` | `home_utilities` |
| (transfer) | 2026-08-04 09:00 | `acc-omar` | 400.00 | `Transfer · alquiler agosto` | `income` |
| `demo-omar-062` | 2026-08-05 23:20 | `acc-omar` | -112.30 | `RYANAIR 2245518121 DUBLIN IE` | `transport` |
| `demo-omar-063` | 2026-08-07 12:40 | `acc-omar` | -146.00 | `IKEA MALAGA` | `shopping` |
| `demo-omar-014` | 2026-08-08 20:00 | `acc-omar` | -23.40 | `CARREFOUR EXPRESS 1182 MALAGA ESP` | `groceries` |
| `demo-omar-015` | 2026-08-09 06:00 | `acc-omar` | -13.99 | `NETFLIX.COM AMSTERDAM NL` | `eating_out_leisure` |
| `demo-omar-016` | 2026-08-11 06:00 | `acc-omar` | -9.25 | `GITHUB, INC. SAN FRANCISCO US` | `work` |
| `demo-omar-064` | 2026-08-12 19:30 | `acc-omar` | -77.45 | `MERCADONA 1904 MALAGA` | `groceries` |
| `demo-omar-065` | 2026-08-13 18:10 | `acc-omar` | -12.40 | `FARMACIA LARIOS 0031` | `health` |
| `demo-omar-017` | 2026-08-14 22:00 | `acc-omar` | -16.40 | `UBER *EATS PENDING AMSTERDAM` | `eating_out_leisure` |
| `demo-omar-018` | 2026-08-15 21:30 | `acc-omar` | -68.00 | `RESTAURANTE CASA PACO S.L.` | `eating_out_leisure` |
| `demo-omar-019` | 2026-08-16 08:00 | `acc-omar` | -58.70 | `TOTALENERGIES CLIENTES SAU` | `home_utilities` |
| `demo-omar-066` | 2026-08-17 08:50 | `acc-omar` | -38.90 | `RENFE VIAJEROS INTERNET MADRID` | `transport` |
| `demo-omar-067` | 2026-08-18 19:20 | `acc-omar` | -61.90 | `LIDL SUPERMERCADOS SAU MALAGA` | `groceries` |
| `demo-omar-068` | 2026-08-20 17:00 | `acc-omar` | -45.00 | `FISIOTERAPIA MALAGUETA SLP` | `health` |
| `demo-omar-020` | 2026-08-21 06:00 | `acc-omar` | -2.99 | `APPLE.COM/BILL ITUNES.COM IE` | to review |
| `demo-omar-021` | 2026-08-22 08:00 | `acc-omar` | -38.00 | `O2 FIBRA RECIBO` | `home_utilities` |
| `demo-omar-022` | 2026-08-23 19:40 | `acc-omar` | -31.80 | `CARREFOUR EXPRESS 1182 MALAGA ESP` | `groceries` |
| `demo-omar-069` | 2026-08-25 01:10 | `acc-omar` | -16.20 | `CABIFY ESPANA SLU` | `transport` |
| `demo-omar-070` | 2026-08-26 18:40 | `acc-omar` | -59.90 | `UNIQLO MALAGA` | `shopping` |
| `demo-omar-023` | 2026-08-27 07:00 | `acc-omar` | 2,900.00 | `PAYROLL AUG - GLOBEX EU BV` | `income` |
| `demo-omar-071` | 2026-08-29 12:15 | `acc-omar` | -69.30 | `MERCADONA 1904 MALAGA` | `groceries` |
| `demo-omar-024` | 2026-08-30 19:00 | `acc-omar` | -300.00 | `REVOLUT**7741* DUBLIN` | to review |
| `demo-omar-025` | 2026-09-01 06:00 | `acc-omar` | -4.99 | `AMAZON PRIME*2R4TT1 LUXEMBOURG LU` | to review |
| (transfer) | 2026-09-01 09:00 | `acc-omar` | 400.00 | `Transfer · alquiler septiembre` | `income` |
| `demo-omar-026` | 2026-09-02 06:00 | `acc-omar` | -9.50 | `NOTION LABS INC` | `work` |
| `demo-omar-027` | 2026-09-03 08:00 | `acc-omar` | -1,100.00 | `RECIBO ALQUILER COSTA PROPERTIES SL` | `home_utilities` |
| `demo-omar-072` | 2026-09-04 19:20 | `acc-omar` | -74.80 | `MERCADONA 1904 MALAGA` | `groceries` |
| `demo-omar-028` | 2026-09-04 23:10 | `acc-omar` | -78.99 | `RYANAIR 2245519872 DUBLIN IE` | `transport` |
| `demo-omar-029` | 2026-09-05 21:50 | `acc-omar` | -58.00 | `RESTAURANTE CASA PACO S.L.` | `eating_out_leisure` |
| `demo-omar-030` | 2026-09-06 01:20 | `acc-omar` | -14.20 | `UBER *TRIP HELP.UBER.COM NL` | `transport` |
| `demo-omar-031` | 2026-09-09 06:00 | `acc-omar` | -13.99 | `NETFLIX.COM AMSTERDAM NL` | `eating_out_leisure` |
| `demo-omar-032` | 2026-09-10 22:15 | `acc-omar` | -22.10 | `UBER *EATS PENDING AMSTERDAM` | `eating_out_leisure` |
| `demo-omar-033` | 2026-09-11 06:00 | `acc-omar` | -9.25 | `GITHUB, INC. SAN FRANCISCO US` | `work` |
| `demo-omar-073` | 2026-09-11 19:05 | `acc-omar` | -66.25 | `LIDL SUPERMERCADOS SAU MALAGA` | `groceries` |
| `demo-omar-034` | 2026-09-12 15:00 | `acc-omar` | -54.20 | `AMZN Mktp ES*9P2KK4LQ0` | to review |
| `demo-omar-074` | 2026-09-13 11:30 | `acc-omar` | -119.00 | `PCCOMPONENTES Y MULTIMEDIA SL` | `shopping` |
| `demo-omar-035` | 2026-09-15 10:00 | `acc-omar` | -35.00 | `QUIRONSALUD HOSP. MALAGA` | `health` |
| `demo-omar-036` | 2026-09-16 08:00 | `acc-omar` | -58.70 | `TOTALENERGIES CLIENTES SAU` | `home_utilities` |
| `demo-omar-075` | 2026-09-18 19:40 | `acc-omar` | -83.10 | `MERCADONA 1904 MALAGA` | `groceries` |
| `demo-omar-037` | 2026-09-19 12:10 | `acc-omar` | -9.00 | `SQ *LITTLE PAPER STORE` | to review |
| `demo-omar-038` | 2026-09-20 19:30 | `acc-omar` | -27.15 | `CARREFOUR EXPRESS 1182 MALAGA ESP` | `groceries` |
| `demo-omar-039` | 2026-09-21 06:00 | `acc-omar` | -2.99 | `APPLE.COM/BILL ITUNES.COM IE` | to review |
| `demo-omar-040` | 2026-09-22 08:00 | `acc-omar` | -38.00 | `O2 FIBRA RECIBO` | `home_utilities` |
| `demo-omar-041` | 2026-09-24 21:40 | `acc-omar` | -18.75 | `UBER *EATS PENDING AMSTERDAM` | `eating_out_leisure` |
| `demo-omar-042` | 2026-09-26 23:30 | `acc-omar` | -11.35 | `UBER *TRIP HELP.UBER.COM NL` | `transport` |
| `demo-omar-043` | 2026-09-27 19:00 | `acc-omar` | -300.00 | `REVOLUT**7741* DUBLIN` | to review |
| `demo-omar-044` | 2026-09-28 07:00 | `acc-omar` | 2,900.00 | `PAYROLL SEP - GLOBEX EU BV` | `income` |
| `demo-omar-076` | 2026-09-29 19:30 | `acc-omar` | -62.40 | `MERCADONA 1904 MALAGA` | `groceries` |
| `demo-omar-045` | 2026-10-02 18:40 | `acc-omar` | -14.60 | `FARMACIA LARIOS 0031` | `health` |
| `demo-omar-046` | 2026-10-03 08:00 | `acc-omar` | -1,100.00 | `RECIBO ALQUILER COSTA PROPERTIES SL` | `home_utilities` |
| `demo-omar-047` | 2026-10-03 20:30 | `acc-omar` | -31.45 | `CARREFOUR EXPRESS 1182 MALAGA ESP` | `groceries` |
| `demo-omar-048` | 2026-10-04 12:20 | `acc-omar` | -59.99 | `DECATHLON MALAGA` | `shopping` |
| `demo-omar-049` | 2026-10-04 21:10 | `acc-omar` | -52.00 | `RESTAURANTE CASA PACO S.L.` | `eating_out_leisure` |
| `demo-omar-050` | 2026-10-05 01:05 | `acc-omar` | -12.80 | `UBER *TRIP HELP.UBER.COM NL` | `transport` |
| `demo-omar-077` | 2026-10-05 19:25 | `acc-omar` | -88.20 | `MERCADONA 1904 MALAGA` | `groceries` |
| `demo-omar-078` | 2026-10-06 13:10 | `acc-omar` | -28.75 | `LIDL SUPERMERCADOS SAU MALAGA` | `groceries` |

/**
 * The absolute ceiling on a stock total, shared by the quartermaster and warehouse
 * modules and by the two client dialogs that offer "set new total".
 *
 * WHY A CEILING AT ALL: movement deltas are a Postgres `integer` column and on-hand is
 * their SUM read into an `integer` variable. An absurd absolute total overflows that sum
 * and bricks every later write to the row with "integer out of range" — fail-closed, but
 * unrecoverable without hand-posting a compensating movement. Because a set-total lands
 * the SUM exactly on the target, this bound caps on-hand outright rather than merely
 * bounding one movement.
 *
 * Dependency-free on purpose, so it compiles under BOTH tsconfigs: the dialogs can show
 * and pre-check the limit without importing anything under lib/db, which the ESLint
 * client/server boundary forbids (see eslint.config.js `no-restricted-imports`).
 *
 * THE AUTHORITATIVE CHECKS ARE IN SQL — `qm_set_inventory_total` and
 * `warehouse_set_stock_total` each raise on their own, because a client-side bound is
 * cosmetic. This constant must stay equal to the literal in those two functions;
 * tests/schemaStockGuards.test.ts pins that they agree.
 */
export const MAX_STOCK_TOTAL = 100_000_000;

import {
  connectNats,
  ensureStream,
  ensureConsumerForSigner,
} from "../src/nats/stream.js";
import { getSql, closeSql } from "../src/db/client.js";
import { Hex } from "viem";

async function main() {
  const ctx = await connectNats(
    process.env.NATS_URL ?? "nats://localhost:4222",
  );
  await ensureStream(ctx.jsm);
  console.log("stream 'decrypt-work' ensured");

  const sql = getSql();
  const signers = await sql<
    { addr: string }[]
  >`SELECT addr FROM app.signers WHERE enabled`;
  for (const s of signers) {
    await ensureConsumerForSigner(ctx.jsm, s.addr as Hex);
    console.log("consumer ensured for", s.addr);
  }
  await ctx.nc.close();
  await closeSql();
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});

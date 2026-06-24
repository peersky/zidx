import { createPublicClient, createWalletClient, http, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";

async function main() {
  const TOKEN = process.env.TOKEN_ADDRESS as `0x${string}`;
  const PK = process.env.DEPLOYER_PK as `0x${string}`;
  const RPC = process.env.RPC_URL!;

  const ABI = parseAbi([
    "function mint(address to, bytes32 encryptedAmount, bytes calldata inputProof) returns (bytes32)",
  ]);

  const chain: any = { id: 31337, name: "anvil", nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } };
  const account = privateKeyToAccount(PK);
  const publicClient = createPublicClient({ chain, transport: http(RPC) });
  const walletClient = createWalletClient({ account, chain, transport: http(RPC) });

  const sdkMod: any = await import("@zama-fhe/sdk");
  const viemMod: any = await import("@zama-fhe/sdk/viem");
  const config = viemMod.createConfig({
    chains: [sdkMod.anvil],
    walletClient, publicClient,
    relayers: { [sdkMod.anvil.id]: sdkMod.cleartext() },
    storage: new sdkMod.MemoryStorage(),
  });
  const sdk = new sdkMod.ZamaSDK(config);
  const enc = await sdk.relayer.encrypt({
    values: [{ value: 9999n, type: "euint64" }],
    contractAddress: TOKEN, userAddress: account.address,
  });
  console.log("encrypted, calling mint…");
  const txh = await walletClient.writeContract({
    address: TOKEN, abi: ABI, functionName: "mint",
    args: [account.address, enc.encryptedValues[0], enc.inputProof],
    chain, account,
  } as any);
  console.log("tx:", txh);
  const r = await publicClient.waitForTransactionReceipt({ hash: txh });
  console.log("mined, block:", r.blockNumber, "logs:", r.logs.length);
}
main().catch(e => { console.error(e); process.exit(1); });

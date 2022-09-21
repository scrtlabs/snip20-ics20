import { sha256 } from "@noble/hashes/sha256";
import { execSync } from "child_process";
import * as fs from "fs";
import {
  MsgExecuteContract,
  MsgInstantiateContract,
  MsgStoreCode,
  SecretNetworkClient,
  toBase64,
  toHex,
  toUtf8,
  TxResultCode,
  Wallet,
} from "secretjs";
import { AminoWallet } from "secretjs/dist/wallet_amino";
import {
  ibcDenom,
  sleep,
  waitForBlocks,
  waitForIBCChannel,
  waitForIBCConnection,
} from "./utils";

type Account = {
  address: string;
  mnemonic: string;
  walletAmino: AminoWallet;
  walletProto: Wallet;
  secretjs: SecretNetworkClient;
};

const accounts1 = new Array<Account>(2);
const accounts2 = new Array<Account>(2);

type Contract = {
  wasm: Uint8Array;
  address: string;
  codeId: number;
  ibcPortId: string;
  codeHash: string;
};

const contracts: { snip20: Contract; ics20: Contract } = {
  snip20: {
    wasm: new Uint8Array(),
    address: "",
    codeId: -1,
    ibcPortId: "",
    codeHash: "",
  },
  ics20: {
    wasm: new Uint8Array(),
    address: "",
    codeId: -1,
    ibcPortId: "",
    codeHash: "",
  },
};

let channelId1 = "";
let channelId2 = "";

beforeAll(async () => {
  const mnemonics = [
    "grant rice replace explain federal release fix clever romance raise often wild taxi quarter soccer fiber love must tape steak together observe swap guitar",
    "jelly shadow frog dirt dragon use armed praise universe win jungle close inmate rain oil canvas beauty pioneer chef soccer icon dizzy thunder meadow",
  ];

  // Create clients for all of the existing wallets in secretdev-1
  for (let i = 0; i < mnemonics.length; i++) {
    const mnemonic = mnemonics[i];
    const walletAmino = new AminoWallet(mnemonic);
    accounts1[i] = {
      address: walletAmino.address,
      mnemonic: mnemonic,
      walletAmino,
      walletProto: new Wallet(mnemonic),
      secretjs: await SecretNetworkClient.create({
        grpcWebUrl: "http://localhost:9091",
        wallet: walletAmino,
        walletAddress: walletAmino.address,
        chainId: "secretdev-1",
      }),
    };
  }

  // Create clients for all of the existing wallets in secretdev-2
  for (let i = 0; i < mnemonics.length; i++) {
    const mnemonic = mnemonics[i];
    const walletAmino = new AminoWallet(mnemonic);
    accounts2[i] = {
      address: walletAmino.address,
      mnemonic: mnemonic,
      walletAmino,
      walletProto: new Wallet(mnemonic),
      secretjs: await SecretNetworkClient.create({
        grpcWebUrl: "http://localhost:9391",
        wallet: walletAmino,
        walletAddress: walletAmino.address,
        chainId: "secretdev-2",
      }),
    };
  }

  await waitForBlocks("secretdev-1", "http://localhost:9091");
  await waitForBlocks("secretdev-2", "http://localhost:9391");

  contracts.snip20.wasm = fs.readFileSync(
    `${__dirname}/snip20.wasm`
  ) as Uint8Array;
  contracts.ics20.wasm = fs.readFileSync(
    `${__dirname}/../contract.wasm`
  ) as Uint8Array;

  contracts.snip20.codeHash = toHex(sha256(contracts.snip20.wasm));
  contracts.ics20.codeHash = toHex(sha256(contracts.ics20.wasm));

  console.log("Storing contracts on secretdev-1...");

  let tx = await accounts1[0].secretjs.tx.broadcast(
    [
      new MsgStoreCode({
        sender: accounts1[0].address,
        wasmByteCode: contracts.snip20.wasm,
        source: "",
        builder: "",
      }),
      new MsgStoreCode({
        sender: accounts1[0].address,
        wasmByteCode: contracts.ics20.wasm,
        source: "",
        builder: "",
      }),
    ],
    { gasLimit: 5_000_000 }
  );
  if (tx.code !== TxResultCode.Success) {
    console.error(tx.rawLog);
  }
  expect(tx.code).toBe(TxResultCode.Success);

  contracts.snip20.codeId = Number(
    tx.arrayLog.find((x) => x.key === "code_id").value
  );
  contracts.ics20.codeId = Number(
    tx.arrayLog.reverse().find((x) => x.key === "code_id").value
  );

  console.log("Instantiating contracts on secretdev-1...");

  tx = await accounts1[0].secretjs.tx.broadcast(
    [
      new MsgInstantiateContract({
        sender: accounts1[0].address,
        codeId: contracts.snip20.codeId,
        codeHash: contracts.snip20.codeHash,
        initMsg: {
          name: "Secret SCRT",
          admin: accounts1[0].address,
          symbol: "SSCRT",
          decimals: 6,
          initial_balances: [{ address: accounts1[0].address, amount: "1000" }],
          prng_seed: "eW8=",
          config: {
            public_total_supply: true,
            enable_deposit: true,
            enable_redeem: true,
            enable_mint: false,
            enable_burn: false,
          },
          supported_denoms: ["uscrt"],
        },
        label: `snip20-${Date.now()}`,
      }),
      new MsgInstantiateContract({
        sender: accounts1[0].address,
        codeId: contracts.ics20.codeId,
        codeHash: contracts.ics20.codeHash,
        initMsg: {},
        label: `ics20-${Date.now()}`,
      }),
    ],
    { gasLimit: 5_000_000 }
  );
  if (tx.code !== TxResultCode.Success) {
    console.error(tx.rawLog);
  }
  expect(tx.code).toBe(TxResultCode.Success);

  contracts.snip20.address = tx.arrayLog.find(
    (x) => x.key === "contract_address"
  ).value;
  contracts.snip20.ibcPortId = "wasm." + contracts.snip20.address;

  contracts.ics20.address = tx.arrayLog
    .reverse()
    .find((x) => x.key === "contract_address").value;
  contracts.ics20.ibcPortId = "wasm." + contracts.ics20.address;

  console.log("Waiting for IBC to set up...");
  await waitForIBCConnection("secretdev-1", "http://localhost:9091");
  await waitForIBCConnection("secretdev-2", "http://localhost:9391");

  console.log("Creating IBC channel...");

  const command =
    "docker exec test-relayer-1 hermes " +
    "--config /home/hermes-user/.hermes/alternative-config.toml " +
    "create channel --channel-version ics20-1 --order ORDER_UNORDERED " +
    "--a-chain secretdev-1 --a-connection connection-0 " +
    `--b-port transfer --a-port ${contracts.ics20.ibcPortId} > /dev/null`;

  // console.log(command);

  const result = execSync(command);

  const trimmedResult = result.toString().replace(/\s|\n/g, "");

  const regexChannel1 = /a_side.+?,channel_id:Some\(ChannelId\("(channel-\d+)"/;
  channelId1 = regexChannel1.exec(trimmedResult)[1];
  expect(channelId1).toContain("channel-");

  const regexChannel2 = /b_side.+?,channel_id:Some\(ChannelId\("(channel-\d+)"/;
  channelId2 = regexChannel2.exec(trimmedResult)[1];
  expect(channelId2).toContain("channel-");

  await waitForIBCChannel("secretdev-1", "http://localhost:9091", channelId1);
  await waitForIBCChannel("secretdev-2", "http://localhost:9391", channelId2);
}, 180_000 /* 3 minutes timeout */);

test("send from 1 to 2", async () => {
  let tx = await accounts1[0].secretjs.tx.broadcast(
    [
      new MsgExecuteContract({
        sender: accounts1[0].address,
        contractAddress: contracts.ics20.address,
        codeHash: contracts.ics20.codeHash,
        msg: {
          register_tokens: {
            tokens: [
              {
                address: contracts.snip20.address,
                code_hash: contracts.snip20.codeHash,
              },
            ],
          },
        },
      }),
      new MsgExecuteContract({
        sender: accounts1[0].address,
        contractAddress: contracts.snip20.address,
        codeHash: contracts.snip20.codeHash,
        msg: {
          send: {
            recipient: contracts.ics20.address,
            recipient_code_hash: contracts.ics20.codeHash,
            amount: "1",
            msg: toBase64(
              toUtf8(
                JSON.stringify({
                  channel: channelId1,
                  remote_address: accounts2[1].address,
                  timeout: 10 * 60, // 10 minutes
                })
              )
            ),
          },
        },
      }),
    ],
    {
      gasLimit: 5_000_000,
    }
  );
  if (tx.code !== TxResultCode.Success) {
    console.error(tx.rawLog);
  }
  expect(tx.code).toBe(TxResultCode.Success);

  console.log(tx.arrayLog);

  console.log("Waiting for balance on secretdev-2");

  const expectedIbcDenom = ibcDenom(
    [{ incomingChannelId: channelId2, incomingPortId: "transfer" }],
    `cw20:${contracts.snip20.address}`
  );

  while (true) {
    execSync(
      `docker exec test-relayer-1 hermes clear packets --chain secretdev-2 --port transfer --channel ${channelId2}`
    );

    const { balance } = await accounts2[1].secretjs.query.bank.balance({
      denom: expectedIbcDenom,
      address: accounts2[1].address,
    });

    if (balance) {
      expect(balance.amount).toBe("1");
      expect(balance.denom).toBe(expectedIbcDenom);
      break;
    }

    await sleep(5000);
  }
});

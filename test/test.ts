import { sha256 } from "@noble/hashes/sha256";
import { execSync } from "child_process";
import * as fs from "fs";
import {
  fromBase64,
  fromUtf8,
  MsgExecuteContract,
  MsgInstantiateContract,
  MsgStoreCode,
  ProposalType,
  SecretNetworkClient,
  toBase64,
  toHex,
  toUtf8,
  Tx,
  TxResultCode,
  Wallet,
} from "secretjs";
import {
  QueryBalanceRequest,
  QueryBalanceResponse,
} from "secretjs//dist/protobuf_stuff/cosmos/bank/v1beta1/query";
import { MsgSend } from "secretjs/dist/protobuf_stuff/cosmos/bank/v1beta1/tx";
import { ContractCustomInfo } from "secretjs/dist/protobuf_stuff/secret/compute/v1beta1/types";
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
    { gasLimit: 300_000 }
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

  await waitForIBCChannel("secretdev-1", "http://localhost:9091", "channel-0");
  await waitForIBCChannel("secretdev-2", "http://localhost:9391", "channel-0");

  console.log("Creating IBC channel...");

  const command =
    "docker exec test-relayer-1 hermes " +
    "--config /home/hermes-user/.hermes/alternative-config.toml " +
    "create channel --channel-version ics20-1 --order ORDER_UNORDERED " +
    "--a-chain secretdev-1 --a-connection connection-0 " +
    `--b-port transfer --a-port ${contracts.ics20.ibcPortId}`;

  console.log(command);

  const result = execSync(command);

  const trimmedResult = result.toString().replace(/\s|\n/g, "");

  const regexChannel1 = /,channel_id:Some\(ChannelId\("(channel-\d+)"/;
  channelId1 = regexChannel1.exec(trimmedResult)[1];
  expect(channelId1).toContain("channel-");

  const regexChannel2 =
    /,counterparty_channel_id:Some\(ChannelId\("(channel-\d+)"/;
  channelId2 = regexChannel2.exec(trimmedResult)[1];
  expect(channelId2).toContain("channel-");

  await waitForIBCChannel("secretdev-1", "http://localhost:9091", channelId1);
  await waitForIBCChannel("secretdev-2", "http://localhost:9391", channelId2);
}, 180_000 /* 3 minutes timeout */);

test("send from 1 to 2", async () => {
  let tx = await accounts1[0].secretjs.tx.broadcast([
    new MsgExecuteContract({
      sender: accounts1[0].address,
      contractAddress: contracts.ics20.address,
      codeHash: contracts.ics20.codeHash,
      msg: {
        register_tokens: {
          tokens: [
            {
              address: contracts.snip20.address,
              code_hash: contracts.snip20.address,
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
  ]);
  if (tx.code !== TxResultCode.Success) {
    console.error(tx.rawLog);
  }
  expect(tx.code).toBe(TxResultCode.Success);

  console.log("Waiting for balance on secretdev-2");

  while (true) {
    const balances = await accounts2[1].secretjs.query.bank.allBalances({
      address: accounts2[1].address,
    });
    console.log(balances);
    sleep(1000);
  }
});

// describe("IBC", () => {
//   test("contracts sanity", async () => {
//     const res: any = await readonly.query.compute.queryContract({
//       contractAddress: contracts["secretdev-1"].v1.address,
//       codeHash: contracts["secretdev-1"].v1.codeHash,
//       query: {
//         ibc_list_channels: {
//           port_id: "wasm." + contracts["secretdev-1"].v1.address,
//         },
//       },
//     });
//     expect(res?.channels?.length).toBe(1);
//     expect(res?.channels[0]?.endpoint?.port_id).toBe(
//       "wasm." + contracts["secretdev-1"].v1.address
//     );
//     expect(res?.channels[0]?.endpoint?.channel_id).toBe(channelId);

//     const res2: any = await readonly.query.compute.queryContract({
//       contractAddress: contracts["secretdev-1"].v1.address,
//       codeHash: contracts["secretdev-1"].v1.codeHash,
//       query: {
//         ibc_channel: {
//           port_id: "wasm." + contracts["secretdev-1"].v1.address,
//           channel_id: channelId,
//         },
//       },
//     });
//     expect(res2?.channel?.endpoint?.port_id).toBe(
//       "wasm." + contracts["secretdev-1"].v1.address
//     );
//     expect(res2?.channel?.endpoint?.channel_id).toBe(channelId);

//     const tx = await accounts[0].secretjs.tx.compute.executeContract(
//       {
//         sender: accounts[0].address,
//         contractAddress: contracts["secretdev-1"].v1.address,
//         codeHash: contracts["secretdev-1"].v1.codeHash,
//         msg: {
//           send_ibc_packet: {
//             message: "hello from test",
//           },
//         },
//       },
//       { gasLimit: 250_000 }
//     );
//     console.log("tx", tx);
//     if (tx.code !== TxResultCode.Success) {
//       console.error(tx.rawLog);
//     }
//     expect(tx.code).toBe(TxResultCode.Success);
//     console.log(
//       "tx after triggering ibc send endpoint",
//       JSON.stringify(cleanBytes(tx), null, 2)
//     );

//     expect(tx.arrayLog.find((x) => x.key === "packet_data").value).toBe(
//       `{"message":{"value":"${channelId}hello from test"}}`
//     );

//     const packetSendCommand =
//       "docker exec ibc-relayer-1 hermes " +
//       "--config /home/hermes-user/.hermes/alternative-config.toml " +
//       "tx packet-recv --dst-chain secretdev-2 --src-chain secretdev-1 " +
//       `--src-port ${contracts["secretdev-1"].v1.ibcPortId} ` +
//       `--src-channel ${channelId}`;

//     console.log(
//       "calling docker exec on relayer with command",
//       packetSendCommand
//     );
//     let packetSendResult = execSync(packetSendCommand);
//     console.log(
//       "finished executing command, result:",
//       packetSendResult.toString()
//     );

//     const packetAckCommand =
//       "docker exec ibc-relayer-1 hermes " +
//       "--config /home/hermes-user/.hermes/alternative-config.toml " +
//       "tx packet-ack --dst-chain secretdev-1 --src-chain secretdev-2 " +
//       `--src-port ${contracts["secretdev-1"].v1.ibcPortId} ` +
//       `--src-channel ${channelId}`;

//     console.log(
//       "calling docker exec on relayer with command",
//       packetAckCommand
//     );
//     const packetAckResult = execSync(packetAckCommand);
//     console.log(
//       "finished executing command, result:",
//       packetAckResult.toString()
//     );

//     let queryResult: any =
//       await accounts[0].secretjs.query.compute.queryContract({
//         contractAddress: contracts["secretdev-1"].v1.address,
//         codeHash: contracts["secretdev-1"].v1.codeHash,
//         query: {
//           last_ibc_ack: {},
//         },
//       });

//     const ack = fromUtf8(fromBase64(queryResult));

//     expect(ack).toBe(`recv${channelId}hello from test`);

//     queryResult = await accounts2[0].secretjs.query.compute.queryContract({
//       contractAddress: contracts["secretdev-2"].v1.address,
//       codeHash: contracts["secretdev-2"].v1.codeHash,
//       query: {
//         last_ibc_ack: {},
//       },
//     });

//     expect(queryResult).toBe(`no ack yet`);

//     queryResult = await accounts[0].secretjs.query.compute.queryContract({
//       contractAddress: contracts["secretdev-1"].v1.address,
//       codeHash: contracts["secretdev-1"].v1.codeHash,
//       query: {
//         last_ibc_receive: {},
//       },
//     });

//     expect(queryResult).toBe(`no receive yet`);

//     queryResult = await accounts2[0].secretjs.query.compute.queryContract({
//       contractAddress: contracts["secretdev-2"].v1.address,
//       codeHash: contracts["secretdev-2"].v1.codeHash,
//       query: {
//         last_ibc_receive: {},
//       },
//     });

//     expect(queryResult).toBe(`${channelId}hello from test`);
//   }, 80_000 /* 80 seconds */);
// });

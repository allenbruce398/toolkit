import { getEndpoints } from "@zetachain/networks/dist/src/getEndpoints";
import networks from "@zetachain/networks/dist/src/networks";
import { ethers } from "ethers";
import fetch from "isomorphic-fetch";

const apiFetch = async (url: string) => {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Fetch failed with status: ${response.status}`);
  }
  return await response.json();
};

const getEndpoint = (key: any): string => {
  const endpoint = getEndpoints(key, "zeta_testnet")[0]?.url;
  if (!endpoint) {
    throw new Error(`getEndpoints: ${key} endpoint not found`);
  }
  return endpoint;
};

const findByChainId = (config: any, targetChainId: Number): Object | null => {
  for (const key in config) {
    if (config.hasOwnProperty(key) && config[key].hasOwnProperty("chain_id")) {
      if (config[key].chain_id === targetChainId) {
        return key;
      }
    }
  }
  return null;
};

const fetchCCTXByInbound = async (
  hash: string,
  emitter: any,
  spinners: any,
  API: string,
  cctxs: any,
  json: Boolean
) => {
  try {
    const url = `${API}/zeta-chain/crosschain/inTxHashToCctx/${hash}`;
    const apiResponseData = await apiFetch(url);
    const res = apiResponseData?.inTxHashToCctx?.cctx_index;
    res.forEach((hash: any) => {
      if (hash && !cctxs[hash] && !spinners[hash]) {
        cctxs[hash] = [];
        if (!json && emitter) {
          emitter.emit("add", { hash, text: hash });
          spinners[hash] = true;
        }
      }
    });
  } catch (error) {}
};

const fetchCCTXData = async (
  hash: string,
  emitter: any,
  spinners: any,
  API: string,
  cctxs: any,
  pendingNonces: any,
  json: Boolean
) => {
  const cctx = await getCCTX(hash, API);
  const receiver_chainId = cctx?.outbound_tx_params[0]?.receiver_chainId;
  const outbound_tx_hash = cctx?.outbound_tx_params[0]?.outbound_tx_hash;
  let confirmed_on_destination = false;
  if (outbound_tx_hash) {
    const chainName = findByChainId(networks, parseInt(receiver_chainId));
    const rpc = getEndpoints("evm", chainName)[0]?.url;
    const provider = new ethers.providers.JsonRpcProvider(rpc);
    const confirmed = await provider.getTransaction(outbound_tx_hash);
    confirmed_on_destination = confirmed !== null;
  }
  const tx = {
    confirmed_on_destination,
    outbound_tx_hash,
    outbound_tx_tss_nonce: cctx?.outbound_tx_params[0]?.outbound_tx_tss_nonce,
    receiver_chainId,
    sender_chain_id: cctx?.inbound_tx_params?.sender_chain_id,
    status: cctx?.cctx_status?.status,
    status_message: cctx?.cctx_status?.status_message,
  };
  const lastCCTX = cctxs[hash][cctxs[hash].length - 1];
  const isEmpty = cctxs[hash].length === 0;
  const statusDefined =
    tx.status !== undefined && tx.status_message !== undefined;
  if (isEmpty || (statusDefined && lastCCTX.status !== tx.status)) {
    cctxs[hash].push(tx);
    const sender = cctxs[hash]?.[0].sender_chain_id;
    const receiver = cctxs[hash]?.[0].receiver_chainId;
    let queue;
    if (pendingNonces) {
      const pending = pendingNonces.find(
        (n: any) => n.chain_id === tx.receiver_chainId
      )?.nonce_low;
      const current = tx.outbound_tx_tss_nonce;
      const diff = current - pending;
      queue = diff > 0 ? ` (${diff} in queue)` : "";
    }
    const path = cctxs[hash]
      .map(
        (x: any) =>
          `${x.status} ${x.status_message && "(" + x.status_message + ")"}`
      )
      .join(" → ");
    const text = `${hash}: ${sender} → ${receiver}${queue}: ${path}`;

    if (!json && spinners[hash] && emitter) {
      const s = tx.status;
      if (s == "OutboundMined" || s == "Reverted") {
        emitter.emit("succeed", { hash, text });
        spinners[hash] = false;
      } else if (s == "Aborted") {
        emitter.emit("fail", { hash, text });
        spinners[hash] = false;
      } else {
        emitter.emit("update", { hash, text });
      }
    }
  }
};

const getCCTX = async (hash: string, API: string) => {
  try {
    const url = `${API}/zeta-chain/crosschain/cctx/${hash}`;
    const apiResponseData = await apiFetch(url);
    return apiResponseData?.CrossChainTx;
  } catch (e) {}
};

const fetchNonces = async (API: string, TSS: string) => {
  try {
    const url = `${API}/zeta-chain/crosschain/pendingNonces`;
    const apiResponseData = await apiFetch(url);
    const nonces = apiResponseData?.pending_nonces;
    return nonces.filter((n: any) => n.tss === TSS);
  } catch (e) {}
};

const fetchTSS = async (API: string) => {
  try {
    const url = `${API}/zeta-chain/crosschain/TSS`;
    const apiResponseData = await apiFetch(url);
    return apiResponseData?.TSS.tss_pubkey;
  } catch (e) {}
};

export const trackCCTX = async (
  hash: string,
  json: Boolean = false,
  emitter: any = null
): Promise<void> => {
  const spinners: any = {};

  const API = getEndpoint("cosmos-http");
  const TSS = await fetchTSS(API);

  return new Promise((resolve, reject) => {
    let cctxs: any = {};
    let pendingNonces: any = [];

    const intervalID = setInterval(async () => {
      pendingNonces = await fetchNonces(API, TSS);
      if (Object.keys(cctxs).length === 0) {
        if (!json && emitter) {
          const text = `Looking for cross-chain transactions (CCTXs) on ZetaChain...\n`;
          emitter.emit("search-add", { text });
          spinners["search"] = true;
        }
        await fetchCCTXByInbound(hash, emitter, spinners, API, cctxs, json);
      }
      if (
        Object.keys(cctxs).length === 0 &&
        !cctxs[hash] &&
        (await getCCTX(hash, API)) &&
        !cctxs[hash]
      ) {
        cctxs[hash] = [];
        if (!spinners[hash] && !json && emitter) {
          spinners[hash] = true;
          emitter.emit("add", { hash, text: hash });
          spinners[hash] = true;
        }
      }
      for (const txHash in cctxs) {
        await fetchCCTXByInbound(txHash, emitter, spinners, API, cctxs, json);
      }
      if (Object.keys(cctxs).length > 0) {
        if (spinners["search"] && !json && emitter) {
          emitter.emit("search-end", {
            text: `CCTXs on ZetaChain found.\n`,
          });
          spinners["search"] = false;
        }
        for (const hash in cctxs) {
          try {
            fetchCCTXData(
              hash,
              emitter,
              spinners,
              API,
              cctxs,
              pendingNonces,
              json
            );
          } catch (error) {}
        }
      }
      if (
        Object.keys(cctxs).length > 0 &&
        Object.keys(cctxs)
          .map((c: any) => {
            const last = cctxs[c][cctxs[c].length - 1];
            return last?.status;
          })
          .filter((s) => !["OutboundMined", "Aborted", "Reverted"].includes(s))
          .length === 0
      ) {
        const allOutboundMined = Object.keys(cctxs)
          .map((c: any) => {
            const last = cctxs[c][cctxs[c].length - 1];
            return last?.status;
          })
          .every((s) => s === "OutboundMined");

        clearInterval(intervalID);

        if (!allOutboundMined) {
          reject("CCTX aborted or reverted");
        } else {
          if (json) console.log(JSON.stringify(cctxs, null, 2));
          resolve();
        }
      }
    }, 3000);
  });
};

async function getSwapDetailsFromHeliusRPC(signature) {
    let retryAttempts = 0;
    let delay = 5000; // 5 segundos inicial antes de la primera consulta

    while (retryAttempts < 6) { // Máximo de 6 intentos
        try {
            console.log(`🔍 Fetching transaction details for: ${signature} (Attempt ${retryAttempts + 1})`);

            const response = await axios.post("https://mainnet.helius-rpc.com/?api-key=0c964f01-0302-4d00-a86c-f389f87a3f35", {
                jsonrpc: "2.0",
                id: 1,
                method: "getTransaction",
                params: [signature, { encoding: "json", commitment: "confirmed", maxSupportedTransactionVersion: 0 }]
            });

            if (!response.data || !response.data.result) {
                throw new Error("❌ No transaction details found.");
            }

            const txData = response.data.result;
            const meta = txData.meta;

            if (meta.err) {
                throw new Error("Transaction failed on Solana.");
            }

            const preBalances = meta.preBalances;
            const postBalances = meta.postBalances;
            const swapFee = meta.fee / 1e9;

            // 🔍 Buscar el token comprado en postTokenBalances
            let receivedToken = meta.postTokenBalances.find(token => {
                return token.uiTokenAmount.uiAmount > 0 && token.uiTokenAmount.uiAmount !== null;
            });

            if (!receivedToken) {
                throw new Error("❌ No valid received token found.");
            }

            const receivedAmount = parseFloat(receivedToken.uiTokenAmount.uiAmountString);
            const receivedTokenMint = receivedToken.mint;

            // 🔍 Buscar el token vendido en preTokenBalances
            let soldToken = meta.preTokenBalances.find(token => {
                return token.uiTokenAmount.uiAmount > 0 && token.mint !== receivedTokenMint;
            });

            let soldAmount = soldToken ? parseFloat(soldToken.uiTokenAmount.uiAmountString) : "N/A";
            let soldTokenMint = soldToken ? soldToken.mint : "Unknown";

            // 🔹 Obtener nombres y símbolos de los tokens
            let soldTokenInfo = getTokenInfo(soldTokenMint);
            let receivedTokenInfo = getTokenInfo(receivedTokenMint);

            const soldTokenName = soldTokenInfo?.name || "Unknown";
            const soldTokenSymbol = soldTokenInfo?.symbol || "N/A";

            const receivedTokenName = receivedTokenInfo?.name || "Unknown";
            const receivedTokenSymbol = receivedTokenInfo?.symbol || "N/A";

            // Detectar en qué plataforma se hizo el swap (Jupiter, Raydium, Meteora, etc.)
            const dexPlatform = detectDexPlatform(txData.transaction.message.accountKeys);

            const solBefore = preBalances[0] / 1e9;
            const solAfter = postBalances[0] / 1e9;
            const inputAmount = soldTokenSymbol === "SOL" ? (solBefore - solAfter - swapFee).toFixed(6) : soldAmount.toFixed(6);

            return {
                inputAmount: inputAmount,
                soldAmount: soldAmount,
                receivedAmount: receivedAmount.toFixed(6),
                swapFee: swapFee.toFixed(6),
                soldTokenMint: soldTokenMint,
                receivedTokenMint: receivedTokenMint,
                soldTokenName: soldTokenName,
                soldTokenSymbol: soldTokenSymbol,
                receivedTokenName: receivedTokenName,
                receivedTokenSymbol: receivedTokenSymbol,
                dexPlatform: dexPlatform,
                walletAddress: txData.transaction.message.accountKeys[0],
                solBefore: solBefore.toFixed(3),
                solAfter: solAfter.toFixed(3)
            };

        } catch (error) {
            console.error(`❌ Error retrieving swap details (Attempt ${retryAttempts + 1}):`, error.message);

            if (error.response && error.response.status === 429) {
                console.log("⚠️ Rate limit reached, waiting longer before retrying...");
                delay *= 1.5;
            } else {
                delay *= 1.2;
            }

            await new Promise(resolve => setTimeout(resolve, delay));
            retryAttempts++;
        }
    }

    console.error("❌ Failed to retrieve swap details after multiple attempts.");
    return null;
}

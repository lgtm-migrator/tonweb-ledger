import TonWeb from "tonweb";

/**
 * Copy-paste from TonWeb.WalletContract
 * @param query     result of wallet.createTransferMessage
 * @param provider  TonWeb provider
 * @return {Promise<{estimateFee: function, send: function, getQuery: function}>}
 */
const createTransferResult = async (query, provider) => {
    const createQuery = () => {
        const legacyQuery = {
            address: query.address.toString(true, true, true),
            body: query.body.toObject(),
        }
        return {query, legacyQuery};
    }

    const promise = createQuery();

    return {
        getQuery: async () => {
            return promise.query.message;
        },
        send: async () => {
            const query = promise.query;
            const boc = TonWeb.utils.bytesToBase64(await query.message.toBoc(false));
            return provider.sendBoc(boc);
        },
        estimateFee: async () => {
            const legacyQuery = promise.legacyQuery;
            return provider.getEstimateFee(legacyQuery); // todo: get fee by boc
        }
    }
}

/**
 * Copy-paste from TonWeb.Contract
 * @param query     result of wallet.createInitExternalMessage
 * @param provider  TonWeb provider
 * @return {Promise<{estimateFee: function, send: function, getQuery: function}>}
 */
const createDeployResult = async (query, provider) => {
    const createQuery = () => {
        const legacyQuery = {
            address: query.address.toString(true, true, false),
            body: query.body.toObject(),
            init_code: query.code.toObject(),
            init_data: query.data.toObject(),
        }
        return {query, legacyQuery};
    }

    const promise = createQuery();

    return {
        getQuery: async () => {
            return promise.query.message;
        },
        send: async () => {
            const query = promise.query;
            const boc = TonWeb.utils.bytesToBase64(await query.message.toBoc(false));
            return provider.sendBoc(boc);
        },
        estimateFee: async () => {
            const legacyQuery = promise.legacyQuery;
            return provider.getEstimateFee(legacyQuery); // todo: get fee by boc
        }
    }
}

export class AppTon {

    /**
     * @param transport {Transport} @ledgerhq/hw-transport
     * @param ton   {TonWeb}
     */
    constructor(transport, ton) {
        this.transport = transport;
        this.ton = ton;

        // todo: узнать зачем вызывается decorateAppAPIMethods
        // const scrambleKey = "w0w";
        // transport.decorateAppAPIMethods(
        //     this,
        //     [
        //         "getAppConfiguration",
        //         "getAddress",
        //         "sign",
        //         "signTransfer",
        //     ],
        //     scrambleKey
        // );
    }

    /***
     * Get App version
     * @return {{version: string}}
     */
    async getAppConfiguration() {
        const response = await this.transport.send(0xe0, 0x01, 0x00, 0x00);
        return {
            version: "" + response[0] + "." + response[1] + "." + response[2] // major version, minor version, patch version
        };
    }

    /**
     * This command returns a wallet address and public key for the given account number
     * @param accountNumber {number}
     * @param isDisplay {boolean} display public key and confirm before returning
     * @return {{publicKey: Uint8Array, address: Address, wallet: WalletContract}}
     */
    async getAddress(accountNumber, isDisplay) {
        const buffer = Buffer.alloc(4);
        buffer.writeInt32BE(accountNumber);

        const response = await this.transport
            .send(
                0xe0,
                0x02,
                isDisplay ? 0x01 : 0x00,
                0x00,
                buffer
            );
        const len = response[0];
        const publicKey = new Uint8Array(response.slice(1, 1 + len));

        const WalletClass = this.ton.wallet.all['WalletV3ContractR1'];
        const wallet = new WalletClass(this.ton.provider, {
            publicKey: publicKey,
            wc: 0
        });
        const address = await wallet.getAddress();
        return {publicKey, address, wallet};
    }

    /**
     * Sign a bytes
     * @param accountNumber {number}
     * @param buffer    {Buffer}
     * @return {{signature: Buffer}}
     */
    async sign(accountNumber, buffer) {
        const accountNumberBuffer = Buffer.alloc(4);
        accountNumberBuffer.writeInt32BE(accountNumber);
        const signBuffer = Buffer.concat([accountNumberBuffer, new Buffer(buffer)]);

        const response = await this.transport
            .send(
                0xe0,
                0x03,
                0x00,
                0x00,
                signBuffer
            );

        const result = {};
        const len = response[0];
        result.signature = response.slice(1, 1 + len);
        return result;
    }

    /**
     * Same with TonWeb.WalletContract.createTransferMessage
     * @param accountNumber {number}
     * @param wallet {WalletContract}  Sender wallet
     * @param toAddress {String | Address}  Destination address in any format
     * @param amount    {BN | number}  Transfer value in nanograms
     * @param seqno {number}
     * @return
     */
    async transfer(accountNumber, wallet, toAddress, amount, seqno) {
        const selfAddress = await wallet.getAddress();
        const sendMode = 3;

        const query = await wallet.createTransferMessage(null, toAddress, amount, seqno, null, sendMode, true);

        const accountNumberBuffer = Buffer.alloc(4);
        accountNumberBuffer.writeInt32BE(accountNumber);
        const msgBuffer = Buffer.concat([accountNumberBuffer, new Buffer(await query.signingMessage.toBoc())]);

        const response = await this.transport
            .send(
                0xe0,
                0x04,
                0x00,
                0x00,
                msgBuffer
            );

        const len = response[0];
        const signatureBuffer = response.slice(1, 1 + len);
        const signature = new Uint8Array(signatureBuffer);

        const body = new TonWeb.boc.Cell();
        body.bits.writeBytes(signature);
        body.writeCell(query.signingMessage);
        const header = TonWeb.Contract.createExternalMessageHeader(selfAddress);
        const resultMessage = TonWeb.Contract.createCommonMsgInfo(header, null, body);

        return createTransferResult(
            {
                address: selfAddress,
                message: resultMessage, // old wallet_send_generate_external_message

                body: body,
                signature: signature,
                signingMessage: query.signingMessage,
            },
            this.ton.provider
        );
    }

    /**
     * Same with TonWeb.Contract.createInitExternalMessage
     * @param accountNumber {number}
     * @param wallet {WalletContract}  Sender wallet
     */
    async deploy(accountNumber, wallet) {
        const {stateInit, address, code, data} = await wallet.createStateInit();
        const signingMessage = wallet.createSigningMessage();
        const signResult = await this.sign(accountNumber, await signingMessage.hash());
        const signature = new Uint8Array(signResult.signature);

        const body = new TonWeb.boc.Cell();
        body.bits.writeBytes(signature);
        body.writeCell(signingMessage);

        const header = TonWeb.Contract.createExternalMessageHeader(address);
        const externalMessage = TonWeb.Contract.createCommonMsgInfo(header, stateInit, body);

        return createDeployResult(
            {
                address: address,
                message: externalMessage,

                body,
                signingMessage,
                stateInit,
                code,
                data,
            },
            this.ton.provider
        );
    }

}
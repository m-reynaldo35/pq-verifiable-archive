import algosdk from 'algosdk';

const account = algosdk.generateAccount();
const mnemonic = algosdk.secretKeyToMnemonic(account.sk);

console.log('=== Algorand Testnet Anchor Wallet ===');
console.log('Address :', account.addr.toString());
console.log('Mnemonic:', mnemonic);
console.log('');
console.log('Add to .env:');
console.log(`ALGORAND_MNEMONIC="${mnemonic}"`);
console.log('');
console.log('Fund at: https://bank.testnet.algorand.network');

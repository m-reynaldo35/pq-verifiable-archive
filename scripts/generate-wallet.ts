import algosdk from 'algosdk';

const account = algosdk.generateAccount();
const mnemonic = algosdk.secretKeyToMnemonic(account.sk);

console.log('=== Algorand Mainnet Anchor Wallet ===');
console.log('Address :', account.addr.toString());
console.log('Mnemonic:', mnemonic);
console.log('');
console.log('Add to .env:');
console.log(`ALGORAND_MNEMONIC="${mnemonic}"`);

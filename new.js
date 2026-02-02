// 1️⃣ Your Angel One Secret Key (HEX format)
const hex = "f5fa4bae904b4a90a83747536cb224d6";

// 2️⃣ Function to convert HEX → Base32
function hexToBase32(hexString) {
  const bytes = [];
  for (let i = 0; i < hexString.length; i += 2) {
    bytes.push(parseInt(hexString.substr(i, 2), 16));
  }

  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "", base32 = "";

  for (const byte of bytes) {
    bits += byte.toString(2).padStart(8, "0");

    while (bits.length >= 5) {
      base32 += alphabet[parseInt(bits.substring(0, 5), 2)];
      bits = bits.substring(5);
    }
  }

  if (bits.length > 0) {
    base32 += alphabet[parseInt(bits.padEnd(5, "0"), 2)];
  }

  return base32;
}

// 3️⃣ Run conversion
console.log("Base32 Secret:", hexToBase32(hex));

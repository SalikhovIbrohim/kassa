import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";

// scrypt is built into Node, so there is no native dependency to build on the server.
const KEY_LENGTH = 64;
const SALT_LENGTH = 16;
const COST = 2 ** 15; // N
const BLOCK_SIZE = 8; // r
const PARALLELISM = 1; // p
const FORMAT = "scrypt";

function derive(
  password: string,
  salt: Buffer,
  cost: number,
  blockSize: number,
  parallelism: number,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(
      password.normalize("NFKC"),
      salt,
      KEY_LENGTH,
      { N: cost, r: blockSize, p: parallelism, maxmem: 256 * cost * blockSize },
      (error, key) => (error ? reject(error) : resolve(key)),
    );
  });
}

/** Returns a self-describing string: format$N$r$p$salt$hash. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LENGTH);
  const key = await derive(password, salt, COST, BLOCK_SIZE, PARALLELISM);
  return [FORMAT, COST, BLOCK_SIZE, PARALLELISM, salt.toString("base64"), key.toString("base64")].join("$");
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [format, cost, blockSize, parallelism, salt, hash] = stored.split("$");
  if (format !== FORMAT || !cost || !blockSize || !parallelism || !salt || !hash) {
    return false;
  }
  const expected = Buffer.from(hash, "base64");
  const actual = await derive(
    password,
    Buffer.from(salt, "base64"),
    Number(cost),
    Number(blockSize),
    Number(parallelism),
  );
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

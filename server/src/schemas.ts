/**
 * For string properties in request schemas: no NUL character. PostgreSQL text cannot hold
 * it, so an unchecked one fails deep inside a query and used to come back as a 500.
 */
export const NO_NUL = "^[^\\u0000]*$";

/**
 * An id in the one form the API speaks: 8-4-4-4-12 hexadecimal digits. The plain "uuid"
 * format also lets "urn:uuid:..." through, which PostgreSQL does not read: it used to come
 * back as a 500. The length keeps it out before the format is even looked at.
 */
export const UUID = { type: "string", format: "uuid", maxLength: 36 } as const;

/** For routes that take no query string: an unknown parameter is a mistake, not noise. */
export const NO_QUERY = { type: "object", additionalProperties: false } as const;

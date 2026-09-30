/**
 * For string properties in request schemas: no NUL character. PostgreSQL text cannot hold
 * it, so an unchecked one fails deep inside a query and used to come back as a 500.
 */
export const NO_NUL = "^[^\\u0000]*$";

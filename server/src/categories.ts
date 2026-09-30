/**
 * Where money can go. The list is fixed: to change it the developer edits it here,
 * there is no screen for it. `code` is what is stored, `label` is what people read.
 */
export const EXPENSE_CATEGORIES = [
  { code: "fuel_road", label: "Топливо и дорога" },
  { code: "salaries", label: "Зарплаты и выплаты" },
  { code: "household_repair", label: "Хозяйство и ремонт" },
  { code: "owner_handover", label: "Передача владельцу" },
  { code: "client_refund", label: "Возврат клиенту" },
  { code: "other", label: "Прочее" },
] as const;

export type ExpenseCategory = (typeof EXPENSE_CATEGORIES)[number]["code"];

export const EXPENSE_CATEGORY_CODES: string[] = EXPENSE_CATEGORIES.map((category) => category.code);

/** Money handed to the owner: it leaves the cash desk but is not a cost of the business. */
export const HANDOVER_CATEGORY: ExpenseCategory = "owner_handover";

/** The only category that names a client. */
export const REFUND_CATEGORY: ExpenseCategory = "client_refund";

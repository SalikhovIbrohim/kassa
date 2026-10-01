import { describe, expect, it } from "vitest";
import { caretPosition, formatAmountText } from "./AmountInput";
import { parseAmountInput } from "./money";

describe("formatAmountText", () => {
  it("separates the thousands as the amount grows", () => {
    expect(formatAmountText("500")).toBe("500");
    expect(formatAmountText("5000")).toBe("5 000");
    expect(formatAmountText("500000")).toBe("500 000");
    expect(formatAmountText("1234567")).toBe("1 234 567");
  });

  it("is not disturbed by spaces that are already there", () => {
    expect(formatAmountText("5 000")).toBe("5 000");
    expect(formatAmountText("1 500 000")).toBe("1 500 000");
    expect(formatAmountText("500 0000")).toBe("5 000 000");
  });

  it("keeps a comma and up to two decimals, and takes a dot for a comma", () => {
    expect(formatAmountText("1500,5")).toBe("1 500,5");
    expect(formatAmountText("1500.50")).toBe("1 500,50");
    expect(formatAmountText("1500,505")).toBe("1 500,50");
    expect(formatAmountText("12,")).toBe("12,");
    expect(formatAmountText("12,3,4")).toBe("12,34");
  });

  it("starts a comma with a zero, and drops what is not a digit", () => {
    expect(formatAmountText(",5")).toBe("0,5");
    expect(formatAmountText("12abc3")).toBe("123");
    expect(formatAmountText("")).toBe("");
    expect(formatAmountText("abc")).toBe("");
  });

  it("does not take more digits than the server accepts", () => {
    expect(formatAmountText("12345678901")).toBe("1 234 567 890");
  });

  it("gives text that is still read as the same amount", () => {
    expect(parseAmountInput(formatAmountText("500000"))).toBe(50_000_000);
    expect(parseAmountInput(formatAmountText("1500.5"))).toBe(150_050);
  });
});

describe("caretPosition", () => {
  it("puts the caret at the end when nothing is to its right", () => {
    expect(caretPosition("5 000", 0)).toBe(5);
  });

  it("keeps the caret before the same digits when a space appears to its left", () => {
    // "12|34" typed as "1 2|34": two digits to the right of the caret, in both.
    expect(caretPosition("1 234", 2)).toBe(3);
  });

  it("counts the decimal comma as something to the right", () => {
    expect(caretPosition("1 500,50", 3)).toBe(5);
  });
});

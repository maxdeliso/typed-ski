/**
 * Parser constants.
 *
 * This module provides centralized constants used throughout the parser,
 * including character constants for syntax tokens and regex patterns.
 *
 * @module
 */

// Character constants
export const LEFT_PAREN = "(";
export const RIGHT_PAREN = ")";
export const LEFT_BRACE = "{";
export const RIGHT_BRACE = "}";
export const COLON = ":";
export const EQUALS = "=";
export const BACKSLASH = "\\";
export const HASH = "#";
export const ARROW = "->";
export const FAT_ARROW = "=>";
export const PIPE = "|";

// Regex patterns
export const DIGIT_REGEX = /[0-9]/;
export const PURELY_NUMERIC_REGEX = /^[0-9]+$/;
export const WHITESPACE_REGEX = /\s/;
export const IDENTIFIER_CHAR_REGEX = /[a-zA-Z0-9_]/;

// Other constants
export const ASCII_MAX = 0x7f;

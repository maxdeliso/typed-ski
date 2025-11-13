/**
 * Version constant read from deno.jsonc at module load time
 */
import { dirname, fromFileUrl, join } from "std/path";

const __dirname = dirname(fromFileUrl(import.meta.url));
const projectRoot = join(__dirname, "../..");
const denoJsonPath = join(projectRoot, "deno.jsonc");

const denoJson = await Deno.readTextFile(denoJsonPath);
const json = JSON.parse(denoJson);
export const VERSION = json.version || "unknown";

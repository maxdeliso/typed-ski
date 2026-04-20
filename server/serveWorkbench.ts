#!/usr/bin/env -S node --disable-warning=ExperimentalWarning --experimental-transform-types

import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { readFile, realpath, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Simple HTTP server for WASM profiling demo
 * Sets required headers for SharedArrayBuffer support
 * Serves from project root to access wasm/ directory
 * Expects pre-bundled JavaScript files for any TypeScript requests.
 */

const PORT = parseInt(process.argv[2] || "8080", 10);

// Get project root (parent of server/)
const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRootPath = resolve(__dirname, "..");

function isWithinProjectRoot(path: string): boolean {
  const relPath = relative(projectRootPath, path);
  return (
    relPath === "" ||
    (!relPath.startsWith("..") && relPath !== ".." && !isAbsolute(relPath))
  );
}

// Base headers for SharedArrayBuffer support
const baseHeaders = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
};

const contentTypeTable: Record<string, string> = {
  ".html": "text/html",
  ".wasm": "application/wasm",
  ".js": "application/javascript",
  ".css": "text/css",
  ".json": "application/json",
};

function getContentType(filePath: string): string {
  const lastDot = filePath.lastIndexOf(".");
  if (lastDot === -1) return "text/plain";
  const ext = filePath.substring(lastDot);
  return contentTypeTable[ext] || "text/plain";
}

const server = createServer(
  async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url || "/", `http://localhost:${PORT}`);
    let filePath = url.pathname;

    if (filePath === "/") {
      filePath = "/server/workbench.html";
    }

    if (filePath === "/workbench.html") {
      filePath = "/server/workbench.html";
    }

    const localPath = filePath.startsWith("/") ? filePath.slice(1) : filePath;
    const fullPathString = resolve(projectRootPath, localPath);

    try {
      if (!isWithinProjectRoot(fullPathString)) {
        res.writeHead(403);
        res.end("Forbidden");
        return;
      }

      const resolvedPath = await realpath(fullPathString);
      if (!isWithinProjectRoot(resolvedPath)) {
        res.writeHead(403);
        res.end("Forbidden");
        return;
      }

      const fileStat = await stat(resolvedPath);

      if (localPath.endsWith(".ts") || localPath.endsWith(".tsx")) {
        const bundleFileName = localPath
          .substring(localPath.lastIndexOf("/") + 1)
          .replace(/\.tsx?$/, ".js");
        const jsPath = join(projectRootPath, "dist", bundleFileName);

        try {
          const jsContent = await readFile(jsPath, "utf8");
          res.writeHead(200, {
            ...baseHeaders,
            "Content-Type": "application/javascript",
          });
          res.end(jsContent);
          return;
        } catch (_e) {
          const errorMsg =
            `Error: Pre-bundled JavaScript file not found for ${localPath}.\n` +
            `Expected at: ${jsPath}\n\n` +
            `The workbench now serves browser bundles from dist/. ` +
            `Please run 'bazelisk run //:hephaestus_assets' ` +
            `or 'bazelisk run //:serve_hephaestus' to generate the necessary artifacts.`;

          console.error(errorMsg);
          res.writeHead(500, { "Content-Type": "text/plain" });
          res.end(errorMsg);
          return;
        }
      }

      const contentType = getContentType(localPath);
      res.writeHead(200, {
        ...baseHeaders,
        "Content-Type": contentType,
        "Content-Length": fileStat.size,
      });

      createReadStream(resolvedPath).pipe(res);
    } catch (error: any) {
      if (error.code === "ENOENT") {
        res.writeHead(404);
        res.end("Not Found");
      } else {
        res.writeHead(500);
        res.end(`Error: ${error.message}`);
      }
    }
  },
);

const url = `http://localhost:${PORT}/workbench.html`;
console.log(`Starting server...`);
console.log(`\n  ${url}\n`);
console.log("Press Ctrl+C to stop\n");

server.listen(PORT, "127.0.0.1");

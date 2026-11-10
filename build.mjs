// Builds index.html from index.src.html: precompiles the JSX so phones do not run Babel on every open.
// Usage: node build.mjs [srcFile] [outFile]
import fs from "node:fs";
import Babel from "@babel/standalone";

const src = process.argv[2] || "index.src.html";
const out = process.argv[3] || "index.html";
const html = fs.readFileSync(src, "utf8");
const re = /<script type="text\/babel"[^>]*>([\s\S]*?)<\/script>/;
const m = html.match(re);
if (!m) throw new Error("no text/babel script found");
const compiled = Babel.transform(m[1], { presets: [["react", { runtime: "classic" }]], compact: false, comments: false }).code;
let x = 5381;
for (let i = 0; i < compiled.length; i++) x = ((x << 5) + x + compiled.charCodeAt(i)) | 0;
const version = (x >>> 0).toString(36);
if (compiled.includes("</script")) throw new Error("compiled code contains </script");
let outHtml = html.replace(re, () => `<script id="zion-main">\n${compiled}\n</script>\n<script type="text/babel" id="zion-version">${version}</script>`);
outHtml = outHtml.replace(/<script src="https:\/\/cdnjs\.cloudflare\.com\/ajax\/libs\/babel-standalone\/[^"]*"><\/script>\n?/, "");
fs.writeFileSync(out, outHtml);
console.log("built", out, outHtml.length, "bytes, version", version);

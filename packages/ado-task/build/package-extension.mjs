import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// repoRoot = <repo>/ (3 levels up from packages/ado-task/build/)
const repoRoot = path.resolve(__dirname, "../../..");
const adoTaskRoot = path.join(repoRoot, "packages", "ado-task");

// Output extension layout
const outRoot = path.join(repoRoot, "out", "azure-devops-extension");
const outTaskDir = path.join(outRoot, "tasks", "ADOCodeReview");

// Extension source (manifest + assets)
const extensionRoot = path.join(repoRoot, "extensions", "azure-devops");

// Helpers
function rm(dir) {
    fs.rmSync(dir, { recursive: true, force: true });
}
function mkdir(dir) {
    fs.mkdirSync(dir, { recursive: true });
}
function copyFile(src, dst) {
    mkdir(path.dirname(dst));
    fs.copyFileSync(src, dst);
}
function copyDir(srcDir, dstDir) {
    mkdir(dstDir);
    for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
        const src = path.join(srcDir, entry.name);
        const dst = path.join(dstDir, entry.name);
        if (entry.isDirectory()) copyDir(src, dst);
        else copyFile(src, dst);
    }
}

// Validate folders
if (!fs.existsSync(adoTaskRoot)) {
    throw new Error(`adoTaskRoot not found: ${adoTaskRoot}`);
}
if (!fs.existsSync(extensionRoot)) {
    throw new Error(
        `extensionRoot not found: ${extensionRoot}\n` +
        `Create it and put vss-extension.json + assets/ there.`
    );
}

// Pick esbuild executable from node_modules/.bin (portable)
const esbuildBin =
    process.platform === "win32"
        ? path.join(repoRoot, "node_modules", ".bin", "esbuild.cmd")
        : path.join(repoRoot, "node_modules", ".bin", "esbuild");

if (!fs.existsSync(esbuildBin)) {
    throw new Error(
        `esbuild not found at: ${esbuildBin}\n` +
        `Run 'npm install' (or 'npm ci') at repo root to install dependencies.`
    );
}

// 1) Clean output
rm(outRoot);
mkdir(outRoot);

// 2) Bundle task -> packages/ado-task/dist/main.js
rm(path.join(adoTaskRoot, "dist"));
mkdir(path.join(adoTaskRoot, "dist"));

const esbuildCmd = [
    `"${esbuildBin}"`,
    "src/main.ts",
    "--bundle",
    "--platform=node",
    "--format=cjs",
    "--target=node16",
    "--outfile=dist/main.js",
    "--sourcemap",
    "--log-level=info",
    // IMPORTANT: prevent bundling task-lib and its dynamic deps (shelljs uses dynamic requires like ./src/cat)
    "--external:azure-pipelines-task-lib",
    "--external:azure-pipelines-task-lib/*",
    "--external:shelljs",
    "--external:shelljs/*",
    "--external:glob",
    "--external:glob/*",
].join(" ");

console.log("🏗️  Bundling task with esbuild...");
execSync(esbuildCmd, { cwd: adoTaskRoot, stdio: "inherit" });

// 3) Copy task.json + bundled dist into out/tasks/ADOCodeReview
console.log("📁 Copying task files into out/ ...");
copyFile(path.join(adoTaskRoot, "task.json"), path.join(outTaskDir, "task.json"));
copyDir(path.join(adoTaskRoot, "dist"), path.join(outTaskDir, "dist"));

// 3.5) Install runtime deps into out/tasks/ADOCodeReview/node_modules
// We externalized azure-pipelines-task-lib/shelljs/glob, so we ship them via node_modules.
console.log("📦 Writing minimal task runtime package.json...");
const taskPkgJsonPath = path.join(outTaskDir, "package.json");

fs.writeFileSync(
    taskPkgJsonPath,
    JSON.stringify(
        {
            name: "tdp-code-review-task-runtime",
            private: true,
            version: "1.0.0",
            dependencies: {
                "azure-pipelines-task-lib": "^4.7.0",
                "shelljs": "^0.8.5",
                "glob": "^10.4.5"
            }
        },
        null,
        2
    ),
    "utf8"
);

console.log("📦 Installing task runtime dependencies (production only)...");
execSync("npm install --omit=dev --no-audit --no-fund", {
    cwd: outTaskDir,
    stdio: "inherit"
});

// Optional: keep the output clean (not required, but nice)
rm(path.join(outTaskDir, "package-lock.json"));

// 4) Copy extension manifest + assets into out/
console.log("📄 Copying extension manifest + assets...");
copyFile(path.join(extensionRoot, "vss-extension.json"), path.join(outRoot, "vss-extension.json"));
copyDir(path.join(extensionRoot, "assets"), path.join(outRoot, "assets"));

console.log("\n✅ Packaged extension layout created at:", outRoot);
console.log("   Next:");
console.log("   Push-Location out/azure-devops-extension");
console.log("   tfx extension create --manifest-globs vss-extension.json");
console.log("   Pop-Location\n");

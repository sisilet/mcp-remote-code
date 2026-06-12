#!/usr/bin/env node

/**
 * Post-build script: Add shebang to build/index.js for CLI execution
 */

import fs from "fs/promises"
import path from "path"
import { fileURLToPath } from "url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(__dirname, "..")
const indexPath = path.join(rootDir, "build", "index.js")

async function main() {
  try {
    const content = await fs.readFile(indexPath, "utf-8")
    
    if (content.startsWith("#!/usr/bin/env node")) {
      console.log("[postbuild] Shebang already exists, skipping.")
      return
    }
    
    const withShebang = `#!/usr/bin/env node\n\n${content}`
    await fs.writeFile(indexPath, withShebang, "utf-8")
    
    // Make executable on Unix systems
    try {
      await fs.chmod(indexPath, 0o755)
    } catch {
      // Ignore chmod errors on Windows
    }
    
    console.log("[postbuild] Added shebang to build/index.js")
  } catch (err) {
    console.error("[postbuild] Error:", err)
    process.exit(1)
  }
}

main()

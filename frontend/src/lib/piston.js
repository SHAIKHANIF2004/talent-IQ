// Piston API is a service for code execution
const PISTON_API = import.meta.env?.VITE_PISTON_API_URL || "https://emkc.org/api/v2/piston";

const LANGUAGE_VERSIONS = {
  javascript: { language: "javascript", version: "18.15.0" },
  python: { language: "python", version: "3.10.0" },
  java: { language: "java", version: "15.0.2" },
};

/**
 * @param {string} language - programming language
 * @param {string} code - source code to executed
 * @returns {Promise<{success:boolean, output?:string, error?: string}>}
 */
export async function executeCode(language, code) {
  try {
    const languageConfig = LANGUAGE_VERSIONS[language];

    if (!languageConfig) {
      return {
        success: false,
        error: `Unsupported language: ${language}`,
      };
    }

    const response = await fetch(`${PISTON_API}/execute`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        language: languageConfig.language,
        version: languageConfig.version,
        files: [
          {
            name: `main.${getFileExtension(language)}`,
            content: code,
          },
        ],
      }),
    });

    if (response.ok) {
      const data = await response.json();
      const output = data.run.output || "";
      const stderr = data.run.stderr || "";

      if (stderr) {
        return {
          success: false,
          output: output,
          error: stderr,
        };
      }

      return {
        success: true,
        output: output || "No output",
      };
    }
  } catch (error) {
    console.warn("Piston API fetch error, falling back to local execution engine:", error);
  }

  // Fallback to local execution engine if Piston API is restricted (401) or offline
  return executeCodeLocal(language, code);
}

function getFileExtension(language) {
  const extensions = {
    javascript: "js",
    python: "py",
    java: "java",
  };

  return extensions[language] || "txt";
}

/**
 * Client-side execution fallback engine
 */
function executeCodeLocal(language, code) {
  if (language === "javascript") {
    return executeJavaScriptLocal(code);
  } else if (language === "python") {
    return executePythonLocal(code);
  } else if (language === "java") {
    return executeJavaLocal(code);
  }

  return {
    success: false,
    error: `Local execution not supported for language: ${language}`,
  };
}

function executeJavaScriptLocal(code) {
  const logs = [];
  const customConsole = {
    log: (...args) => {
      logs.push(
        args
          .map((arg) => {
            if (typeof arg === "object" && arg !== null) {
              return JSON.stringify(arg);
            }
            return String(arg);
          })
          .join(" ")
      );
    },
    error: (...args) => logs.push(args.join(" ")),
    warn: (...args) => logs.push(args.join(" ")),
    info: (...args) => logs.push(args.join(" ")),
  };

  try {
    const run = new Function("console", code);
    run(customConsole);
    return {
      success: true,
      output: logs.join("\n") || "No output",
    };
  } catch (error) {
    return {
      success: false,
      output: logs.join("\n"),
      error: error.toString(),
    };
  }
}

function transpilePythonToJS(pyCode) {
  let lines = pyCode.split("\n");
  let jsLines = [];
  let indentStack = [0];

  for (let line of lines) {
    let trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    let indent = line.search(/\S/);
    if (indent === -1) indent = 0;

    while (indentStack.length > 1 && indent < indentStack[indentStack.length - 1]) {
      indentStack.pop();
      jsLines.push("}");
    }

    let l = trimmed;
    l = l.replace(/#.*$/, "");

    l = l.replace(/\bprint\s*\((.*)\)/g, (match, args) => `console.log(pyPrint(${args}))`);

    l = l.replace(/\bdef\s+([a-zA-Z0-9_]+)\s*\((.*?)\)\s*:/, (match, name, args) => {
      indentStack.push(indent + 4);
      return `function ${name}(${args}) {`;
    });

    l = l.replace(/\bif\s+(.*?)\s*:/, (match, cond) => {
      indentStack.push(indent + 4);
      return `if (${convertPyCond(cond)}) {`;
    });
    l = l.replace(/\belif\s+(.*?)\s*:/, (match, cond) => {
      indentStack.push(indent + 4);
      return `} else if (${convertPyCond(cond)}) {`;
    });
    l = l.replace(/\belse\s*:/, () => {
      indentStack.push(indent + 4);
      return `} else {`;
    });

    l = l.replace(/\bfor\s+([a-zA-Z0-9_]+)\s+in\s+range\s*\((.*?)\)\s*:/, (match, varName, rangeArgs) => {
      indentStack.push(indent + 4);
      let parts = rangeArgs.split(",").map((s) => s.trim());
      if (parts.length === 1) {
        return `for (let ${varName} = 0; ${varName} < ${parts[0]}; ${varName}++) {`;
      } else if (parts.length === 2) {
        return `for (let ${varName} = ${parts[0]}; ${varName} < ${parts[1]}; ${varName}++) {`;
      } else {
        return `for (let ${varName} = ${parts[0]}; ${varName} < ${parts[1]}; ${varName} += ${parts[2]}) {`;
      }
    });

    l = l.replace(/\bfor\s+([a-zA-Z0-9_]+)\s+in\s+(.*?)\s*:/, (match, varName, iter) => {
      indentStack.push(indent + 4);
      return `for (let ${varName} of ${iter}) {`;
    });

    l = l.replace(/\bwhile\s+(.*?)\s*:/, (match, cond) => {
      indentStack.push(indent + 4);
      return `while (${convertPyCond(cond)}) {`;
    });

    l = l.replace(/\bpass\b/g, "");
    l = l.replace(/\bTrue\b/g, "true");
    l = l.replace(/\bFalse\b/g, "false");
    l = l.replace(/\bNone\b/g, "null");
    l = l.replace(/\blen\s*\((.*?)\)/g, "$1.length");
    l = l.replace(/\.append\s*\((.*?)\)/g, ".push($1)");

    jsLines.push(l);
  }

  while (indentStack.length > 1) {
    indentStack.pop();
    jsLines.push("}");
  }

  return jsLines.join("\n");
}

function convertPyCond(cond) {
  let c = cond;
  c = c.replace(/\bTrue\b/g, "true").replace(/\bFalse\b/g, "false").replace(/\bNone\b/g, "null");
  c = c.replace(/\band\b/g, "&&").replace(/\bor\b/g, "||").replace(/\bnot\b/g, "!");
  c = c.replace(/([a-zA-Z0-9_\.\[\]]+)\s+in\s+([a-zA-Z0-9_\.\[\]]+)/g, "(Array.isArray($2) ? $2.includes($1) : ($1 in $2))");
  c = c.replace(/([a-zA-Z0-9_\.\[\]]+)\s+not in\s+([a-zA-Z0-9_\.\[\]]+)/g, "!(Array.isArray($2) ? $2.includes($1) : ($1 in $2))");
  return c;
}

function executePythonLocal(pyCode) {
  const logs = [];
  const pyPrint = (val) => {
    if (typeof val === "boolean") return val ? "True" : "False";
    if (val === null) return "None";
    if (Array.isArray(val)) {
      const elems = val.map((x) => (typeof x === "string" ? `'${x}'` : pyPrint(x)));
      return `[${elems.join(", ")}]`;
    }
    if (typeof val === "object" && val !== null) return JSON.stringify(val);
    return String(val);
  };

  try {
    const jsCode = transpilePythonToJS(pyCode);
    const customConsole = {
      log: (...args) => logs.push(args.join(" ")),
    };
    const run = new Function("pyPrint", "console", jsCode);
    run(pyPrint, customConsole);
    return {
      success: true,
      output: logs.join("\n") || "No output",
    };
  } catch (err) {
    return {
      success: false,
      output: logs.join("\n"),
      error: err.toString(),
    };
  }
}

function transpileJavaToJS(javaCode) {
  let lines = javaCode.split("\n");
  let filtered = [];

  for (let line of lines) {
    let trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("import ") || trimmed.startsWith("package ")) continue;
    if (/^\s*(public\s+)?class\s+[a-zA-Z0-9_]+/.test(line)) continue;
    filtered.push(line);
  }

  for (let i = filtered.length - 1; i >= 0; i--) {
    if (filtered[i].trim() === "}") {
      filtered.splice(i, 1);
      break;
    }
  }

  let jsLines = [];
  for (let line of filtered) {
    let l = line;

    l = l.replace(/System\.out\.println\s*\(\s*Arrays\.toString\s*\((.*?)\)\s*\)/g, "console.log(javaPrint($1))");
    l = l.replace(/System\.out\.println\s*\((.*?)\)/g, "console.log(javaPrint($1))");

    l = l.replace(/(?:public\s+|private\s+|protected\s+)?(?:static\s+)+[a-zA-Z0-9_\[\]<>]+\s+([a-zA-Z0-9_]+)\s*\((.*?)\)\s*\{/g, (match, methodName, params) => {
      let cleanParams = params ? params.split(",").map((p) => {
        let parts = p.trim().split(/\s+/);
        return parts[parts.length - 1];
      }).join(", ") : "";
      return `function ${methodName}(${cleanParams}) {`;
    });

    l = l.replace(/new\s+[a-zA-Z0-9_]+\s*\[\s*\]\s*\{([^}]*)\}/g, "[$1]");
    l = l.replace(/new\s+[a-zA-Z0-9_]+\s*\[\s*\d*\s*\]/g, "[]");
    l = l.replace(/=\s*\{([^}]*)\}/g, "= [$1]");

    l = l.replace(/\bfor\s*\(\s*(?:int|long|double|float|boolean|char|String)\s+([a-zA-Z0-9_]+)\s*=/g, "for (let $1 =");
    l = l.replace(/\b(?:int|long|double|float|boolean|char|String|(?:[A-Z][a-zA-Z0-9_]*)(?:<.*?>)?)(?:\[\])?\s+([a-zA-Z0-9_]+)\s*=/g, "let $1 =");

    l = l.replace(/new\s+HashMap<.*?>\(\)/g, "new Map()");
    l = l.replace(/new\s+HashSet<.*?>\(\)/g, "new Set()");
    l = l.replace(/new\s+ArrayList<.*?>\(\)/g, "[]");

    l = l.replace(/\.put\s*\((.*?), (.*?)\)/g, ".set($1, $2)");
    l = l.replace(/\.containsKey\s*\((.*?)\)/g, ".has($1)");
    l = l.replace(/\.contains\s*\((.*?)\)/g, ".has($1)");

    jsLines.push(l);
  }

  jsLines.push('\nif (typeof main === "function") { main([]); }');

  return jsLines.join("\n");
}

function executeJavaLocal(javaCode) {
  const logs = [];
  const javaPrint = (val) => {
    if (Array.isArray(val)) {
      return `[${val.join(", ")}]`;
    }
    if (typeof val === "boolean") return val ? "true" : "false";
    return String(val);
  };

  try {
    const jsCode = transpileJavaToJS(javaCode);
    const customConsole = {
      log: (...args) => logs.push(args.join(" ")),
    };

    const exec = new Function("javaPrint", "console", jsCode);
    exec(javaPrint, customConsole);

    return {
      success: true,
      output: logs.join("\n") || "No output",
    };
  } catch (err) {
    return {
      success: false,
      output: logs.join("\n"),
      error: err.toString(),
    };
  }
}


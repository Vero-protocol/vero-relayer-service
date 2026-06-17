const fs = require('fs');
const path = require('path');

/**
 * Clean Rust source code by removing block comments and line comments.
 */
function stripComments(content) {
  // Strip block comments /* ... */
  let clean = content.replace(/\/\*[\s\S]*?\*\//g, '');
  // Strip line comments // ...
  clean = clean.split('\n').map(line => {
    const idx = line.indexOf('//');
    return idx !== -1 ? line.substring(0, idx) : line;
  }).join('\n');
  return clean;
}

/**
 * Scan the contracts directory and build a call graph.
 */
function generateCallGraph(contractsDir) {
  const rsFiles = [];
  
  function scanDir(dir) {
    if (!fs.existsSync(dir)) return;
    const files = fs.readdirSync(dir);
    for (const file of files) {
      const fullPath = path.join(dir, file);
      const stat = fs.statSync(fullPath);
      if (stat.isDirectory()) {
        scanDir(fullPath);
      } else if (file.endsWith('.rs')) {
        rsFiles.push(fullPath);
      }
    }
  }
  
  scanDir(contractsDir);
  
  const modules = {};
  
  for (const filePath of rsFiles) {
    let content = fs.readFileSync(filePath, 'utf8');
    content = stripComments(content);
    
    const baseName = path.basename(filePath, '.rs');
    const moduleName = baseName === 'lib' ? 'lib' : baseName;
    
    // Parse imports
    const imports = {};
    const useRegex = /use\s+([\w:]+)(?:::\{([^}]+)\}|::(\w+))?;/g;
    let match;
    while ((match = useRegex.exec(content)) !== null) {
      const prefix = match[1];
      const braceContent = match[2];
      const singleImport = match[3];
      
      if (braceContent) {
        const parts = braceContent.split(',').map(p => p.trim());
        for (const part of parts) {
          imports[part] = prefix; // e.g. initialize -> admin
        }
      } else if (singleImport) {
        imports[singleImport] = prefix;
      }
    }
    
    // Parse functions
    const functions = [];
    const fnRegex = /(?:pub\s+(?:\([\w\s]+\)\s+)?)?fn\s+(\w+)/g;
    let fnMatch;
    while ((fnMatch = fnRegex.exec(content)) !== null) {
      const fnName = fnMatch[1];
      const startIdx = fnMatch.index;
      
      const braceStart = content.indexOf('{', startIdx);
      if (braceStart === -1) continue;
      
      let depth = 1;
      let braceEnd = -1;
      for (let i = braceStart + 1; i < content.length; i++) {
        const char = content[i];
        if (char === '{') depth++;
        else if (char === '}') {
          depth--;
          if (depth === 0) {
            braceEnd = i;
            break;
          }
        }
      }
      
      if (braceEnd !== -1) {
        const body = content.substring(braceStart + 1, braceEnd);
        functions.push({
          name: fnName,
          body: body,
          isPublic: fnMatch[0].startsWith('pub'),
          filePath: path.relative(contractsDir, filePath)
        });
      }
    }
    
    modules[moduleName] = {
      filePath: path.relative(contractsDir, filePath),
      imports,
      functions
    };
  }
  
  // Now resolve calls
  const nodes = [];
  const edges = [];
  
  // Add compound parent nodes for modules/files
  for (const moduleName of Object.keys(modules)) {
    nodes.push({
      data: {
        id: moduleName,
        label: modules[moduleName].filePath,
        isParent: true
      }
    });
    
    for (const fn of modules[moduleName].functions) {
      const id = `${moduleName}::${fn.name}`;
      nodes.push({
        data: {
          id,
          label: fn.name,
          parent: moduleName,
          isPublic: fn.isPublic,
          file: modules[moduleName].filePath,
          body: fn.body.trim()
        }
      });
    }
  }
  
  // Generate edges
  for (const moduleName of Object.keys(modules)) {
    for (const fn of modules[moduleName].functions) {
      const sourceId = `${moduleName}::${fn.name}`;
      
      // Look for function calls in body: word followed by (
      const callRegex = /\b(\w+)\s*\(/g;
      let callMatch;
      while ((callMatch = callRegex.exec(fn.body)) !== null) {
        const calleeName = callMatch[1];
        
        let targetModule = null;
        
        // 1. Check if calleeName is in imports
        if (modules[moduleName].imports[calleeName]) {
          const importedFrom = modules[moduleName].imports[calleeName];
          const cleanModule = importedFrom.split('::').pop();
          if (modules[cleanModule]) {
            targetModule = cleanModule;
          }
        }
        // 2. Check if defined in same module
        else if (modules[moduleName].functions.some(f => f.name === calleeName)) {
          targetModule = moduleName;
        }
        
        if (targetModule) {
          const targetId = `${targetModule}::${calleeName}`;
          const edgeId = `${sourceId}->${targetId}`;
          if (!edges.some(e => e.data.id === edgeId)) {
            edges.push({
              data: {
                id: edgeId,
                source: sourceId,
                target: targetId
              }
            });
          }
        }
      }
    }
  }
  
  return { nodes, edges };
}

module.exports = {
  generateCallGraph,
  stripComments
};

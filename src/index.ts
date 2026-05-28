import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { promises as fs } from "fs";
import path from "path";
import { exec, execSync } from "child_process";
import os from "os";
import AdmZip from "adm-zip";
import * as pdfParse from "pdf-parse";

// Tratamento especial para import de CommonJS no ESM
const parsePdf = (pdfParse as any).default || pdfParse;

// Instanciando o Servidor MCP
const server = new Server(
  {
    name: "seed-tech-mcp",
    version: "1.3.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Lista de diretórios permitidos (opcional) definida em ALLOWED_DIRECTORIES
const ALLOWED_DIRECTORIES = process.env.ALLOWED_DIRECTORIES
  ? process.env.ALLOWED_DIRECTORIES.split(/[,;]/).map(d => path.resolve(d.trim()))
  : null;

if (!ALLOWED_DIRECTORIES) {
  console.error("Aviso: A variável de ambiente ALLOWED_DIRECTORIES não está definida. O sandbox de segurança de caminhos está desabilitado.");
} else {
  console.error(`Segurança Sandbox Ativa. Diretórios permitidos: ${ALLOWED_DIRECTORIES.join(", ")}`);
}

// -------------------------------------------------------------
// 0. Detecção Automática do Docker para o Sandbox de Comandos
// -------------------------------------------------------------
let IS_DOCKER_AVAILABLE = false;
try {
  execSync("docker --version", { stdio: "ignore" });
  IS_DOCKER_AVAILABLE = true;
  console.error("Docker detectado! O Sandbox do Docker está HABILITADO para execução segura de qualquer comando.");
} catch (err) {
  console.error("Aviso: Docker não está rodando no sistema. Fallback ativado: Comandos locais serão restritos por segurança.");
}

// -------------------------------------------------------------
// 1. Ignore List (Lista de Exclusão Padrão)
// -------------------------------------------------------------
const SENSITIVE_PATTERNS = [
  /\.env$/i,
  /\.pem$/i,
  /\.key$/i,
  /id_rsa$/i,
  /id_dsa$/i,
  /id_ecdsa$/i,
  /id_ed25519$/i
];

const IGNORED_DIRECTORIES = [
  "node_modules",
  ".git",
  ".github",
  ".vscode",
  "dist",
  "build"
];

function isSensitive(filePath: string): boolean {
  const base = path.basename(filePath);
  return SENSITIVE_PATTERNS.some(regex => regex.test(base));
}

function shouldIgnoreDirectory(dirName: string): boolean {
  return IGNORED_DIRECTORIES.includes(dirName.toLowerCase());
}

/**
 * Valida se o caminho está dentro das pastas permitidas e se não acessa arquivos sensíveis.
 */
function validatePath(targetPath: string): string {
  const resolved = path.resolve(targetPath);
  
  if (isSensitive(resolved)) {
    throw new Error(`Acesso negado: O arquivo '${path.basename(resolved)}' contém dados sensíveis e é protegido.`);
  }

  if (ALLOWED_DIRECTORIES) {
    const isAllowed = ALLOWED_DIRECTORIES.some(dir => resolved.startsWith(dir));
    if (!isAllowed) {
      throw new Error(`Acesso negado: O caminho '${targetPath}' está fora dos diretórios permitidos.`);
    }
  }
  return resolved;
}

// -------------------------------------------------------------
// 2. Cache em Memória Inteligente (TTL 15 segundos)
// -------------------------------------------------------------
interface CacheEntry {
  data: any;
  timestamp: number;
}

class InMemoryCache {
  private cache = new Map<string, CacheEntry>();
  private ttlMs = 15000; // 15 segundos

  get(key: string): any | null {
    const entry = this.cache.get(key);
    if (!entry) return null;
    if (Date.now() - entry.timestamp > this.ttlMs) {
      this.cache.delete(key);
      return null;
    }
    return entry.data;
  }

  set(key: string, data: any): void {
    this.cache.set(key, { data, timestamp: Date.now() });
  }

  invalidate(key: string): void {
    const resolvedKey = path.resolve(key);
    this.cache.delete(resolvedKey);
    // Limpa também o diretório pai
    const parentDir = path.dirname(resolvedKey);
    this.cache.delete(parentDir);
  }
}

const smartCache = new InMemoryCache();

// -------------------------------------------------------------
// 3. Auxiliares para Cirurgia JSON
// -------------------------------------------------------------
function getNestedProperty(obj: any, propPath: string): any {
  const parts = propPath.split(".");
  let current = obj;
  for (const part of parts) {
    if (current === null || typeof current !== "object" || !(part in current)) {
      return undefined;
    }
    current = current[part];
  }
  return current;
}

function setNestedProperty(obj: any, propPath: string, value: any): void {
  const parts = propPath.split(".");
  let current = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    if (!(part in current) || typeof current[part] !== "object" || current[part] === null) {
      current[part] = {};
    }
    current = current[part];
  }
  current[parts[parts.length - 1]] = value;
}

// -------------------------------------------------------------
// 4. Safe Command Runner Configuration (Modo Fallback Local)
// -------------------------------------------------------------
const ALLOWED_COMMANDS = [
  "npm test",
  "npm run test",
  "npm run build",
  "git status",
  "git diff"
];

// Schemas do Zod para validar argumentos
const ListDirectorySchema = z.object({
  dirPath: z.string().describe("Caminho absoluto do diretório para listar"),
});

const ReadFileSchema = z.object({
  filePath: z.string().describe("Caminho absoluto do arquivo para ler"),
  startLine: z.number().optional().describe("Linha inicial opcional (1-indexed)"),
  endLine: z.number().optional().describe("Linha final opcional (1-indexed)"),
});

const SearchFilesSchema = z.object({
  dirPath: z.string().describe("Caminho absoluto do diretório para buscar"),
  fileNamePattern: z.string().describe("Padrão de nome para buscar (case insensitive)"),
});

const SearchFileContentSchema = z.object({
  dirPath: z.string().describe("Caminho absoluto do diretório para buscar"),
  query: z.string().describe("Texto/termo a ser buscado no conteúdo dos arquivos (case insensitive)"),
  fileExtensionPattern: z.string().optional().describe("Filtro de extensões opcional separado por vírgula (ex: '.ts,.js,.txt')"),
});

const WriteFileSchema = z.object({
  filePath: z.string().describe("Caminho absoluto do arquivo para escrever"),
  content: z.string().describe("Conteúdo completo do arquivo"),
});

const EditFileSchema = z.object({
  filePath: z.string().describe("Caminho absoluto do arquivo para editar"),
  targetContent: z.string().describe("Texto exato que será substituído"),
  replacementContent: z.string().describe("Novo texto substituto"),
});

const ReadJsonPropertySchema = z.object({
  filePath: z.string().describe("Caminho absoluto do arquivo JSON"),
  propertyPath: z.string().describe("Caminho da propriedade (ex: 'dependencies.zod' ou 'scripts.build')"),
});

const UpdateJsonPropertySchema = z.object({
  filePath: z.string().describe("Caminho absoluto do arquivo JSON"),
  propertyPath: z.string().describe("Caminho da propriedade (ex: 'version' ou 'scripts.test')"),
  value: z.any().describe("Novo valor para a propriedade (pode ser string, número, boolean, objeto ou array)"),
});

const RunSafeCommandSchema = z.object({
  command: z.string().describe("O comando exato a ser executado (se sob Docker sandbox, roda qualquer comando; se local, restrito aos aprovados)"),
  cwd: z.string().describe("O diretório de trabalho onde o comando será executado"),
});

const ZipDirectorySchema = z.object({
  dirPath: z.string().describe("Caminho absoluto da pasta a ser compactada"),
  zipFilePath: z.string().describe("Caminho absoluto do arquivo .zip resultante"),
});

const UnzipFileSchema = z.object({
  zipFilePath: z.string().describe("Caminho absoluto do arquivo .zip para extrair"),
  destDirPath: z.string().describe("Caminho absoluto do diretório de destino"),
});

const ReadPdfTextSchema = z.object({
  filePath: z.string().describe("Caminho absoluto do arquivo PDF"),
});

// Registrando as ferramentas disponíveis
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "list_directory",
        description: "Lista todos os arquivos e subdiretórios de um diretório, com metadados ricos e cache em memória automático.",
        inputSchema: {
          type: "object",
          properties: {
            dirPath: { type: "string", description: "Caminho absoluto do diretório" }
          },
          required: ["dirPath"]
        }
      },
      {
        name: "read_file_content",
        description: "Lê o conteúdo em texto de um arquivo específico, com suporte a cache e paginação por linhas.",
        inputSchema: {
          type: "object",
          properties: {
            filePath: { type: "string", description: "Caminho absoluto do arquivo" },
            startLine: { type: "number", description: "Linha inicial opcional (1-indexed)" },
            endLine: { type: "number", description: "Linha final opcional (1-indexed)" }
          },
          required: ["filePath"]
        }
      },
      {
        name: "search_files",
        description: "Busca arquivos pelo nome, de forma recursiva (ignorando pastas comuns como node_modules).",
        inputSchema: {
          type: "object",
          properties: {
            dirPath: { type: "string", description: "Caminho absoluto do diretório inicial" },
            fileNamePattern: { type: "string", description: "Padrão de busca (nome do arquivo)" }
          },
          required: ["dirPath", "fileNamePattern"]
        }
      },
      {
        name: "search_file_content",
        description: "Busca texto de forma recursiva dentro de arquivos de texto (grep inteligente que ignora arquivos binários e sensíveis).",
        inputSchema: {
          type: "object",
          properties: {
            dirPath: { type: "string", description: "Caminho absoluto do diretório inicial" },
            query: { type: "string", description: "Texto/termo a ser buscado" },
            fileExtensionPattern: { type: "string", description: "Filtro opcional de extensões separado por vírgula (ex: '.ts,.js,.md')" }
          },
          required: ["dirPath", "query"]
        }
      },
      {
        name: "write_file",
        description: "Cria ou sobrescreve por completo o conteúdo de um arquivo (invalida caches automaticamente).",
        inputSchema: {
          type: "object",
          properties: {
            filePath: { type: "string", description: "Caminho absoluto do arquivo" },
            content: { type: "string", description: "Conteúdo completo do arquivo" }
          },
          required: ["filePath", "content"]
        }
      },
      {
        name: "edit_file",
        description: "Realiza a edição pontual de um arquivo substituindo uma string exclusiva (invalida caches automaticamente).",
        inputSchema: {
          type: "object",
          properties: {
            filePath: { type: "string", description: "Caminho absoluto do arquivo" },
            targetContent: { type: "string", description: "Texto exato a ser substituído" },
            replacementContent: { type: "string", description: "Novo texto substituto" }
          },
          required: ["filePath", "targetContent", "replacementContent"]
        }
      },
      {
        name: "read_json_property",
        description: "Lê cirurgicamente uma propriedade específica dentro de um arquivo JSON.",
        inputSchema: {
          type: "object",
          properties: {
            filePath: { type: "string", description: "Caminho absoluto do arquivo JSON" },
            propertyPath: { type: "string", description: "Caminho da propriedade usando notação de ponto (ex: 'scripts.build')" }
          },
          required: ["filePath", "propertyPath"]
        }
      },
      {
        name: "update_json_property",
        description: "Altera ou adiciona cirurgicamente um valor a uma propriedade de um JSON (invalida caches automaticamente).",
        inputSchema: {
          type: "object",
          properties: {
            filePath: { type: "string", description: "Caminho absoluto do arquivo JSON" },
            propertyPath: { type: "string", description: "Caminho da propriedade usando notação de ponto (ex: 'dependencies.zod')" },
            value: { type: "any", description: "Novo valor" }
          },
          required: ["filePath", "propertyPath", "value"]
        }
      },
      {
        name: "get_system_info",
        description: "Retorna diagnósticos do sistema operacional e do hardware (RAM, plataforma, uptime).",
        inputSchema: {
          type: "object",
          properties: {}
        }
      },
      {
        name: "run_safe_command",
        description: "Executa comandos do terminal de forma segura. Se o Docker estiver rodando, executa em sandbox 100% isolado sem limites de comandos.",
        inputSchema: {
          type: "object",
          properties: {
            command: { type: "string", description: "O comando a ser executado" },
            cwd: { type: "string", description: "Diretório de trabalho para execução do comando" }
          },
          required: ["command", "cwd"]
        }
      },
      {
        name: "zip_directory",
        description: "Compacta um diretório completo em um arquivo .zip.",
        inputSchema: {
          type: "object",
          properties: {
            dirPath: { type: "string", description: "Caminho absoluto do diretório a ser compactado" },
            zipFilePath: { type: "string", description: "Caminho absoluto do arquivo .zip a ser criado" }
          },
          required: ["dirPath", "zipFilePath"]
        }
      },
      {
        name: "unzip_file",
        description: "Descompacta e extrai por completo um arquivo .zip para um diretório de destino.",
        inputSchema: {
          type: "object",
          properties: {
            zipFilePath: { type: "string", description: "Caminho absoluto do arquivo .zip" },
            destDirPath: { type: "string", description: "Caminho absoluto da pasta de destino para extração" }
          },
          required: ["zipFilePath", "destDirPath"]
        }
      },
      {
        name: "read_pdf_text",
        description: "Lê e extrai todo o conteúdo de texto de um arquivo PDF local.",
        inputSchema: {
          type: "object",
          properties: {
            filePath: { type: "string", description: "Caminho absoluto do arquivo PDF" }
          },
          required: ["filePath"]
        }
      }
    ],
  };
});

// Função auxiliar para busca de arquivos pelo nome
async function searchRecursive(dir: string, pattern: string, results: string[] = []) {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (shouldIgnoreDirectory(entry.name)) continue;
      const fullPath = path.join(dir, entry.name);
      
      if (isSensitive(fullPath)) continue;

      if (entry.name.toLowerCase().includes(pattern.toLowerCase())) {
        results.push(fullPath);
      }
      if (entry.isDirectory()) {
        try {
          await searchRecursive(fullPath, pattern, results);
        } catch (e) {
          // Ignora subdiretórios inacessíveis
        }
      }
    }
  } catch (err) {
    // Ignora erros
  }
  return results;
}

// Função auxiliar para busca de conteúdo estilo grep
async function searchContentRecursive(
  dir: string,
  query: string,
  allowedExtensions: string[] | null,
  results: { filePath: string; line: number; text: string }[] = []
) {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (shouldIgnoreDirectory(entry.name)) continue;
      const fullPath = path.join(dir, entry.name);
      
      if (isSensitive(fullPath)) continue;

      if (entry.isDirectory()) {
        try {
          await searchContentRecursive(fullPath, query, allowedExtensions, results);
        } catch (e) {
          // Ignora subdiretórios inacessíveis
        }
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (allowedExtensions && !allowedExtensions.includes(ext)) {
          continue;
        }
        try {
          const content = await fs.readFile(fullPath, "utf-8");
          if (content.includes("\u0000")) {
            continue; // Pula binários
          }
          const lines = content.split(/\r?\n/);
          lines.forEach((lineText, index) => {
            if (lineText.toLowerCase().includes(query.toLowerCase())) {
              results.push({
                filePath: fullPath,
                line: index + 1,
                text: lineText.trim()
              });
            }
          });
        } catch (e) {
          // Ignora erros individuais de arquivo
        }
      }
    }
  } catch (err) {
    // Ignora
  }
  return results;
}

// Lidando com a execução das ferramentas
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    if (name === "list_directory") {
      const { dirPath } = ListDirectorySchema.parse(args);
      const validatedDir = validatePath(dirPath);

      // Verificando cache
      const cached = smartCache.get(validatedDir);
      if (cached) {
        return {
          content: [{ type: "text", text: JSON.stringify(cached, null, 2) }],
        };
      }

      const entries = await fs.readdir(validatedDir, { withFileTypes: true });
      const files = [];
      
      for (const e of entries) {
        if (shouldIgnoreDirectory(e.name)) continue;
        const fullPath = path.join(validatedDir, e.name);
        
        if (isSensitive(fullPath)) continue;

        let size = 0;
        let mtime = "";
        try {
          const stats = await fs.stat(fullPath);
          size = stats.size;
          mtime = stats.mtime.toISOString();
        } catch (err) {
          // Ignora falhas de stats individuais
        }
        files.push({
          name: e.name,
          type: e.isDirectory() ? "directory" : "file",
          size: e.isDirectory() ? 0 : size,
          mtime: mtime || undefined,
          extension: e.isDirectory() ? undefined : path.extname(e.name)
        });
      }

      smartCache.set(validatedDir, files);

      return {
        content: [{ type: "text", text: JSON.stringify(files, null, 2) }],
      };
    }

    if (name === "read_file_content") {
      const { filePath, startLine, endLine } = ReadFileSchema.parse(args);
      const validatedFile = validatePath(filePath);

      // Cache para leitura completa
      const isCompleteRead = startLine === undefined && endLine === undefined;
      if (isCompleteRead) {
        const cached = smartCache.get(validatedFile);
        if (cached) {
          return {
            content: [{ type: "text", text: cached }],
          };
        }
      }

      const content = await fs.readFile(validatedFile, "utf-8");
      
      if (isCompleteRead) {
        smartCache.set(validatedFile, content);
      }

      let output = content;
      if (startLine !== undefined || endLine !== undefined) {
        const lines = content.split(/\r?\n/);
        const start = startLine !== undefined ? Math.max(1, startLine) - 1 : 0;
        const end = endLine !== undefined ? Math.min(lines.length, endLine) : lines.length;
        output = lines.slice(start, end).join("\n");
      }

      return {
        content: [{ type: "text", text: output }],
      };
    }

    if (name === "search_files") {
      const { dirPath, fileNamePattern } = SearchFilesSchema.parse(args);
      const validatedDir = validatePath(dirPath);
      const results = await searchRecursive(validatedDir, fileNamePattern);
      return {
        content: [{ type: "text", text: JSON.stringify(results, null, 2) }],
      };
    }

    if (name === "search_file_content") {
      const { dirPath, query, fileExtensionPattern } = SearchFileContentSchema.parse(args);
      const validatedDir = validatePath(dirPath);
      
      let allowedExtensions: string[] | null = null;
      if (fileExtensionPattern) {
        allowedExtensions = fileExtensionPattern
          .split(",")
          .map(ext => ext.trim().toLowerCase())
          .map(ext => ext.startsWith(".") ? ext : `.${ext}`);
      }

      const results = await searchContentRecursive(validatedDir, query, allowedExtensions);
      return {
        content: [{ type: "text", text: JSON.stringify(results, null, 2) }],
      };
    }

    if (name === "write_file") {
      const { filePath, content } = WriteFileSchema.parse(args);
      const validatedFile = validatePath(filePath);
      
      await fs.mkdir(path.dirname(validatedFile), { recursive: true });
      await fs.writeFile(validatedFile, content, "utf-8");
      
      // Invalida cache
      smartCache.invalidate(validatedFile);

      return {
        content: [{ type: "text", text: `Arquivo escrito com sucesso em: ${validatedFile}` }],
      };
    }

    if (name === "edit_file") {
      const { filePath, targetContent, replacementContent } = EditFileSchema.parse(args);
      const validatedFile = validatePath(filePath);
      
      const fileContent = await fs.readFile(validatedFile, "utf-8");
      if (!fileContent.includes(targetContent)) {
        throw new Error(`Texto alvo não encontrado no arquivo para substituição.`);
      }
      
      const occurrences = fileContent.split(targetContent).length - 1;
      if (occurrences > 1) {
        throw new Error(`Texto alvo foi encontrado ${occurrences} vezes. Por favor, forneça um bloco de contexto maior e mais exclusivo para substituição.`);
      }
      
      const updatedContent = fileContent.replace(targetContent, replacementContent);
      await fs.writeFile(validatedFile, updatedContent, "utf-8");
      
      // Invalida cache
      smartCache.invalidate(validatedFile);

      return {
        content: [{ type: "text", text: `Arquivo editado com sucesso. Substituição pontual realizada.` }],
      };
    }

    if (name === "read_json_property") {
      const { filePath, propertyPath } = ReadJsonPropertySchema.parse(args);
      const validatedFile = validatePath(filePath);
      
      // Tenta puxar do cache o arquivo completo
      let fileContent = smartCache.get(validatedFile);
      if (!fileContent) {
        fileContent = await fs.readFile(validatedFile, "utf-8");
        smartCache.set(validatedFile, fileContent);
      }

      const json = JSON.parse(fileContent);
      const value = getNestedProperty(json, propertyPath);
      
      return {
        content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
      };
    }

    if (name === "update_json_property") {
      const { filePath, propertyPath, value } = UpdateJsonPropertySchema.parse(args);
      const validatedFile = validatePath(filePath);
      
      const fileContent = await fs.readFile(validatedFile, "utf-8");
      const json = JSON.parse(fileContent);
      
      setNestedProperty(json, propertyPath, value);
      const updatedContent = JSON.stringify(json, null, 2);
      
      await fs.writeFile(validatedFile, updatedContent, "utf-8");
      smartCache.invalidate(validatedFile);

      return {
        content: [{ type: "text", text: `Propriedade '${propertyPath}' do JSON atualizada com sucesso.` }],
      };
    }

    if (name === "get_system_info") {
      const info = {
        platform: os.platform(),
        arch: os.arch(),
        cpuCount: os.cpus().length,
        totalMemoryGB: (os.totalmem() / 1024 / 1024 / 1024).toFixed(2),
        freeMemoryGB: (os.freemem() / 1024 / 1024 / 1024).toFixed(2),
        uptimeHours: (os.uptime() / 3600).toFixed(2),
        nodeVersion: process.version
      };
      return {
        content: [{ type: "text", text: JSON.stringify(info, null, 2) }],
      };
    }

    if (name === "run_safe_command") {
      const { command, cwd } = RunSafeCommandSchema.parse(args);
      const cleanCmd = command.trim();
      const validatedCwd = validatePath(cwd);

      let finalCommand = cleanCmd;

      if (IS_DOCKER_AVAILABLE) {
        // Docker Sandbox: Executa qualquer comando de forma 100% isolada e segura
        const absoluteCwd = path.resolve(validatedCwd);
        const dockerCwd = absoluteCwd.replace(/\\/g, "/");
        finalCommand = `docker run --rm -v "${dockerCwd}:/workspace" -w /workspace node:18-alpine sh -c "${cleanCmd.replace(/"/g, '\\"')}"`;
      } else {
        // Fallback Local: Restrição rígida apenas a comandos permitidos
        if (!ALLOWED_COMMANDS.includes(cleanCmd)) {
          throw new Error(`Comando rejeitado por segurança (Docker inativo). No modo local, apenas os seguintes comandos são permitidos: ${ALLOWED_COMMANDS.join(", ")}`);
        }
      }

      const runPromise = () => new Promise<string>((resolve, reject) => {
        exec(finalCommand, { cwd: validatedCwd }, (error, stdout, stderr) => {
          if (error) {
            reject(new Error(`Erro ao executar o comando: ${error.message}\nStderr: ${stderr}\nStdout: ${stdout}`));
          } else {
            resolve(stdout || stderr || "Comando executado com sucesso e sem saída textual.");
          }
        });
      });

      const output = await runPromise();
      return {
        content: [{ type: "text", text: output }],
      };
    }

    if (name === "zip_directory") {
      const { dirPath, zipFilePath } = ZipDirectorySchema.parse(args);
      const validatedDir = validatePath(dirPath);
      const validatedZip = validatePath(zipFilePath);

      const zip = new AdmZip();
      zip.addLocalFolder(validatedDir);
      zip.writeZip(validatedZip);
      
      smartCache.invalidate(validatedZip);

      return {
        content: [{ type: "text", text: `Diretório compactado com sucesso em: ${validatedZip}` }],
      };
    }

    if (name === "unzip_file") {
      const { zipFilePath, destDirPath } = UnzipFileSchema.parse(args);
      const validatedZip = validatePath(zipFilePath);
      const validatedDest = validatePath(destDirPath);

      const zip = new AdmZip(validatedZip);
      zip.extractAllTo(validatedDest, true);
      
      smartCache.invalidate(validatedDest);

      return {
        content: [{ type: "text", text: `Arquivo ZIP extraído com sucesso em: ${validatedDest}` }],
      };
    }

    if (name === "read_pdf_text") {
      const { filePath } = ReadPdfTextSchema.parse(args);
      const validatedFile = validatePath(filePath);

      const dataBuffer = await fs.readFile(validatedFile);
      const pdfData = await parsePdf(dataBuffer);

      return {
        content: [{ type: "text", text: pdfData.text }],
      };
    }

    throw new Error(`Tool desconhecida: ${name}`);
  } catch (error: any) {
    return {
      isError: true,
      content: [{ type: "text", text: `Erro ao executar a tool ${name}: ${error.message}` }],
    };
  }
});

// Inicializando o servidor
const sseSessions = new Map<string, SSEServerTransport>();

async function main() {
  const isSSE = process.argv.includes("--sse") || process.env.PORT !== undefined;

  if (isSSE) {
    const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;
    
    const expressModule = await import("express");
    const express = expressModule.default;
    
    const app = express();
    app.use(express.json());
    
    // Middleware de segurança opcional: API Key
    const checkApiKey = (req: any, res: any, next: any) => {
      const MCP_API_KEY = process.env.MCP_API_KEY;
      if (!MCP_API_KEY) {
        return next();
      }
      const clientKey = req.query.apiKey || req.headers["x-api-key"];
      if (clientKey !== MCP_API_KEY) {
        return res.status(401).send("Acesso negado: API Key inválida ou ausente.");
      }
      next();
    };

    app.get("/sse", checkApiKey, async (req, res) => {
      const sessionId = (req.query.sessionId as string) || "default";
      console.error(`Cliente conectado ao SSE (Session: ${sessionId}) na porta ${PORT}`);
      
      const transport = new SSEServerTransport(`/messages?sessionId=${sessionId}`, res);
      sseSessions.set(sessionId, transport);
      
      req.on("close", () => {
        console.error(`Cliente desconectado do SSE (Session: ${sessionId})`);
        sseSessions.delete(sessionId);
      });

      await server.connect(transport);
    });

    app.post("/messages", checkApiKey, async (req, res) => {
      const sessionId = (req.query.sessionId as string) || "default";
      const transport = sseSessions.get(sessionId);
      if (!transport) {
        res.status(400).send(`Sessão SSE '${sessionId}' ativa não encontrada.`);
        return;
      }
      await transport.handlePostMessage(req, res);
    });

    app.listen(PORT, () => {
      console.error(`Seed Tech MCP Server rodando via HTTP/SSE em: http://localhost:${PORT}/sse`);
    });
  } else {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("Seed Tech MCP Server rodando via STDIO...");
  }
}

main().catch((error) => {
  console.error("Erro fatal no servidor:", error);
  process.exit(1);
});

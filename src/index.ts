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
import { exec, execSync, ChildProcess } from "child_process";
import os from "os";
import AdmZip from "adm-zip";
import * as pdfParse from "pdf-parse";
import * as sqlite3Module from "sqlite3";

// Tratamento especial para import de CommonJS no ESM
const parsePdf = (pdfParse as any).default || pdfParse;
const sqlite3 = (sqlite3Module as any).default || sqlite3Module;

// Instanciando o Servidor MCP
const server = new Server(
  {
    name: "seed-tech-mcp",
    version: "1.4.0",
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
  execSync("docker ps", { stdio: "ignore" });
  IS_DOCKER_AVAILABLE = true;
  console.error("Docker detectado! O Sandbox do Docker está HABILITADO para execução segura de qualquer comando.");
} catch (err) {
  console.error("Aviso: Docker não está rodando no sistema ou o daemon está inacessível. Fallback ativado: Comandos locais serão restritos por segurança.");
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
    const isAllowed = ALLOWED_DIRECTORIES.some(dir => {
      const relative = path.relative(dir, resolved);
      return !relative.startsWith('..') && !path.isAbsolute(relative);
    });
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
    if (part === "__proto__" || part === "constructor" || part === "prototype") {
      return undefined;
    }
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
    if (part === "__proto__" || part === "constructor" || part === "prototype") {
      throw new Error("Acesso negado: Modificação de protótipo (Prototype Pollution) bloqueada por segurança.");
    }
    if (!(part in current) || typeof current[part] !== "object" || current[part] === null) {
      current[part] = {};
    }
    current = current[part];
  }
  const lastPart = parts[parts.length - 1];
  if (lastPart === "__proto__" || lastPart === "constructor" || lastPart === "prototype") {
    throw new Error("Acesso negado: Modificação de protótipo (Prototype Pollution) bloqueada por segurança.");
  }
  current[lastPart] = value;
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

// -------------------------------------------------------------
// 5. Sistema de Auditoria Geral (mcp_audit.log)
// -------------------------------------------------------------
async function logAudit(action: string, details: any, sessionId = "system") {
  try {
    const logPath = path.resolve(process.cwd(), "mcp_audit.log");
    const entry = JSON.stringify({
      timestamp: new Date().toISOString(),
      action,
      sessionId,
      details
    }) + "\n";
    await fs.appendFile(logPath, entry, "utf-8");
  } catch (e) {
    console.error("Erro ao escrever no log de auditoria:", e);
  }
}

// -------------------------------------------------------------
// 6. Fila de Tarefas Assíncronas (Job Queue)
// -------------------------------------------------------------
interface BackgroundJob {
  id: string;
  process: ChildProcess;
  status: "running" | "completed" | "failed" | "cancelled";
  command: string;
  logs: string[];
}

const backgroundJobs = new Map<string, BackgroundJob>();

// -------------------------------------------------------------
// 7. Motor de Busca Semântica Local (TF-IDF Inteligente)
// -------------------------------------------------------------
interface DocumentToken {
  filePath: string;
  tokens: string[];
  tf: Map<string, number>;
}

async function getFilesInDirectory(dir: string, fileList: string[] = []) {
  // Evitar sobrecarregar a busca semântica em repositórios massivos
  if (fileList.length >= 200) return fileList;
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (shouldIgnoreDirectory(entry.name)) continue;
      const fullPath = path.join(dir, entry.name);
      if (isSensitive(fullPath)) continue;
      if (entry.isDirectory()) {
        await getFilesInDirectory(fullPath, fileList);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        const readableExts = [".ts", ".js", ".json", ".md", ".txt", ".html", ".css", ".yml", ".yaml"];
        if (readableExts.includes(ext)) {
          try {
            const stats = await fs.stat(fullPath);
            // Ignorar arquivos excessivamente grandes (> 500 KB) para evitar OOM
            if (stats.size < 500 * 1024) {
              fileList.push(fullPath);
            }
          } catch (e) {
            // Se falhar no stat, adiciona por precaução
            fileList.push(fullPath);
          }
        }
      }
    }
  } catch (e) {
    // Ignora
  }
  return fileList;
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .split(/\s+/)
    .filter(t => t.length > 2);
}

async function semanticSearch(dirPath: string, query: string): Promise<any[]> {
  const files = await getFilesInDirectory(dirPath);
  const docs: DocumentToken[] = [];
  const df = new Map<string, number>();

  for (const file of files) {
    try {
      const content = await fs.readFile(file, "utf-8");
      const tokens = tokenize(content);
      if (tokens.length === 0) continue;
      
      const tf = new Map<string, number>();
      tokens.forEach(token => {
        tf.set(token, (tf.get(token) || 0) + 1);
      });

      tf.forEach((count, token) => {
        tf.set(token, count / tokens.length);
      });

      docs.push({ filePath: file, tokens, tf });

      const uniqueTokens = new Set(tokens);
      uniqueTokens.forEach(token => {
        df.set(token, (df.get(token) || 0) + 1);
      });
    } catch (e) {
      // Ignora ilegíveis
    }
  }

  const queryTokens = tokenize(query);
  if (queryTokens.length === 0 || docs.length === 0) return [];

  const results: { filePath: string; score: number; snippet: string }[] = [];

  docs.forEach(doc => {
    let score = 0;
    queryTokens.forEach(token => {
      const tf = doc.tf.get(token) || 0;
      if (tf > 0) {
        const docFreq = df.get(token) || 1;
        const idf = Math.log(docs.length / docFreq) + 1;
        score += tf * idf;
      }
    });

    if (score > 0) {
      results.push({
        filePath: doc.filePath,
        score: score,
        snippet: ""
      });
    }
  });

  results.sort((a, b) => b.score - a.score);

  const topResults = results.slice(0, 5);
  for (const res of topResults) {
    try {
      const content = await fs.readFile(res.filePath, "utf-8");
      const lines = content.split(/\r?\n/);
      let bestLine = lines[0] || "";
      for (const line of lines) {
        if (queryTokens.some(token => line.toLowerCase().includes(token))) {
          bestLine = line.trim();
          break;
        }
      }
      res.snippet = bestLine.slice(0, 150);
    } catch (e) {}
  }

  return topResults;
}

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
  zipFilePath: z.string().describe("Caminho absoluto del arquivo .zip resultante"),
});

const UnzipFileSchema = z.object({
  zipFilePath: z.string().describe("Caminho absoluto do arquivo .zip para extrair"),
  destDirPath: z.string().describe("Caminho absoluto do diretório de destino"),
});

const ReadPdfTextSchema = z.object({
  filePath: z.string().describe("Caminho absoluto do arquivo PDF"),
});

const QuerySqliteSchema = z.object({
  dbPath: z.string().describe("Caminho absoluto do arquivo de banco de dados SQLite (.db ou .sqlite)"),
  sqlQuery: z.string().describe("A consulta SQL SELECT a ser executada"),
});

const FetchWebContentSchema = z.object({
  url: z.string().describe("A URL do site ou documentação para requisitar"),
});

const SearchSemanticSchema = z.object({
  dirPath: z.string().describe("Caminho absoluto do diretório inicial"),
  query: z.string().describe("A consulta conceitual/semântica a ser buscada (ex: 'validador de chaves de api')"),
});

const StartBackgroundJobSchema = z.object({
  command: z.string().describe("O comando do terminal a ser iniciado em background"),
  cwd: z.string().describe("Diretório de trabalho para execução do job"),
});

const CheckJobStatusSchema = z.object({
  jobId: z.string().describe("O ID do job retornado ao iniciar"),
});

const CancelJobSchema = z.object({
  jobId: z.string().describe("O ID do job para cancelar"),
});

const GetAuditLogsSchema = z.object({
  linesLimit: z.number().optional().describe("Limite opcional de logs recentes a ler"),
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
        description: "Cria ou sobrescreve por completo o conteúdo de um arquivo (invalida caches e gera auditoria automaticamente).",
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
        description: "Realiza a edição pontual de um arquivo substituindo uma string exclusiva (invalida caches e gera auditoria automaticamente).",
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
        description: "Altera ou adiciona cirurgicamente um valor a uma propriedade de um JSON (invalida caches e gera auditoria automaticamente).",
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
        description: "Executa comandos do terminal de forma síncrona. Se o Docker estiver rodando, executa em sandbox 100% isolado sem limites de comandos.",
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
      },
      {
        name: "query_sqlite",
        description: "Executa consultas SQL SELECT em um banco de dados SQLite local de forma segura e somente-leitura.",
        inputSchema: {
          type: "object",
          properties: {
            dbPath: { type: "string", description: "Caminho absoluto do arquivo SQLite" },
            sqlQuery: { type: "string", description: "A consulta SELECT a ser realizada" }
          },
          required: ["dbPath", "sqlQuery"]
        }
      },
      {
        name: "fetch_web_content",
        description: "Faz requisições GET HTTP seguras para ler documentações ou baixar dados diretamente da web.",
        inputSchema: {
          type: "object",
          properties: {
            url: { type: "string", description: "A URL completa para requisitar" }
          },
          required: ["url"]
        }
      },
      {
        name: "search_semantic",
        description: "Realiza busca semântica conceitual inteligente nos arquivos legíveis locais usando TF-IDF local.",
        inputSchema: {
          type: "object",
          properties: {
            dirPath: { type: "string", description: "Caminho absoluto do diretório inicial" },
            query: { type: "string", description: "A frase ou contexto conceitual a ser buscado" }
          },
          required: ["dirPath", "query"]
        }
      },
      {
        name: "start_background_job",
        description: "Inicia a execução de um comando longo em background, retornando um ID para acompanhamento.",
        inputSchema: {
          type: "object",
          properties: {
            command: { type: "string", description: "O comando a ser executado" },
            cwd: { type: "string", description: "Diretório de trabalho" }
          },
          required: ["command", "cwd"]
        }
      },
      {
        name: "check_job_status",
        description: "Checa o progresso, status atual e logs acumulados (stdout/stderr) de um job em background.",
        inputSchema: {
          type: "object",
          properties: {
            jobId: { type: "string", description: "O ID do job retornado ao iniciar" }
          },
          required: ["jobId"]
        }
      },
      {
        name: "cancel_job",
        description: "Interrompe e cancela imediatamente a execução de um job rodando em background.",
        inputSchema: {
          type: "object",
          properties: {
            jobId: { type: "string", description: "O ID do job para cancelar" }
          },
          required: ["jobId"]
        }
      },
      {
        name: "get_audit_logs",
        description: "Recupera os registros recentes do log de auditoria estruturado local.",
        inputSchema: {
          type: "object",
          properties: {
            linesLimit: { type: "number", description: "Limite opcional de linhas recentes a carregar" }
          }
        }
      }
    ],
  };
});

// Função auxiliar para busca de arquivos pelo nome
async function searchRecursive(dir: string, pattern: string, results: string[] = []) {
  if (results.length >= 1000) return results;
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (results.length >= 1000) break;
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
  if (results.length >= 1000) return results;
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (results.length >= 1000) break;
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
          for (let index = 0; index < lines.length; index++) {
            if (results.length >= 1000) break;
            const lineText = lines[index];
            if (lineText.toLowerCase().includes(query.toLowerCase())) {
              results.push({
                filePath: fullPath,
                line: index + 1,
                text: lineText.trim()
              });
            }
          }
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
  const sessionId = (request.params as any).sessionId || "default";

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
      
      smartCache.invalidate(validatedFile);
      await logAudit("write_file", { filePath: validatedFile }, sessionId);

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
      
      smartCache.invalidate(validatedFile);
      await logAudit("edit_file", { filePath: validatedFile }, sessionId);

      return {
        content: [{ type: "text", text: `Arquivo editado com sucesso. Substituição pontual realizada.` }],
      };
    }

    if (name === "read_json_property") {
      const { filePath, propertyPath } = ReadJsonPropertySchema.parse(args);
      const validatedFile = validatePath(filePath);
      
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
      await logAudit("update_json_property", { filePath: validatedFile, propertyPath }, sessionId);

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
        const absoluteCwd = path.resolve(validatedCwd);
        const dockerCwd = absoluteCwd.replace(/\\/g, "/");
        finalCommand = `docker run --rm -v "${dockerCwd}:/workspace" -w /workspace node:18-alpine sh -c "${cleanCmd.replace(/"/g, '\\"')}"`;
      } else {
        if (!ALLOWED_COMMANDS.includes(cleanCmd)) {
          throw new Error(`Comando rejeitado por segurança (Docker inativo). No modo local, apenas os seguintes comandos são permitidos: ${ALLOWED_COMMANDS.join(", ")}`);
        }
      }

      await logAudit("run_safe_command", { command: cleanCmd, finalCommand, isDocker: IS_DOCKER_AVAILABLE }, sessionId);

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
      await logAudit("zip_directory", { dirPath: validatedDir, zipFilePath: validatedZip }, sessionId);

      return {
        content: [{ type: "text", text: `Diretório compactado com sucesso em: ${validatedZip}` }],
      };
    }

    if (name === "unzip_file") {
      const { zipFilePath, destDirPath } = UnzipFileSchema.parse(args);
      const validatedZip = validatePath(zipFilePath);
      const validatedDest = validatePath(destDirPath);

      const zip = new AdmZip(validatedZip);
      const resolvedDest = path.resolve(validatedDest);

      // Validação de Zip Slip antes de extrair os arquivos
      const zipEntries = zip.getEntries();
      for (const entry of zipEntries) {
        const targetPath = path.resolve(resolvedDest, entry.entryName);
        const relative = path.relative(resolvedDest, targetPath);
        if (relative.startsWith('..') || path.isAbsolute(relative)) {
          throw new Error(`Segurança: Tentativa de Zip Slip detectada no arquivo ZIP para a entrada: ${entry.entryName}`);
        }
      }

      zip.extractAllTo(resolvedDest, true);
      
      smartCache.invalidate(resolvedDest);
      await logAudit("unzip_file", { zipFilePath: validatedZip, destDirPath: resolvedDest }, sessionId);

      return {
        content: [{ type: "text", text: `Arquivo ZIP extraído com sucesso em: ${resolvedDest}` }],
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

    if (name === "query_sqlite") {
      const { dbPath, sqlQuery } = QuerySqliteSchema.parse(args);
      const validatedDb = validatePath(dbPath);
      
      if (!sqlQuery.trim().toLowerCase().startsWith("select")) {
        throw new Error("Acesso negado: Apenas comandos SELECT são permitidos para garantir a segurança.");
      }

      await logAudit("query_sqlite", { dbPath: validatedDb, sqlQuery }, sessionId);

      const runQuery = () => new Promise<any[]>((resolve, reject) => {
        const db = new sqlite3.Database(validatedDb, sqlite3.OPEN_READONLY, (err: any) => {
          if (err) return reject(new Error(`Erro ao abrir o banco de dados: ${err.message}`));
        });

        db.all(sqlQuery, [], (err: any, rows: any[]) => {
          db.close();
          if (err) return reject(new Error(`Erro na query SQL: ${err.message}`));
          resolve(rows);
        });
      });

      const rows = await runQuery();
      return {
        content: [{ type: "text", text: JSON.stringify(rows, null, 2) }],
      };
    }

    if (name === "fetch_web_content") {
      const { url } = FetchWebContentSchema.parse(args);
      await logAudit("fetch_web_content", { url }, sessionId);

      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`Falha na requisição web: status ${response.status}`);
      }
      const text = await response.text();
      return {
        content: [{ type: "text", text: text.slice(0, 100000) }], // Retorna até 100kb
      };
    }

    if (name === "search_semantic") {
      const { dirPath, query } = SearchSemanticSchema.parse(args);
      const validatedDir = validatePath(dirPath);
      const matches = await semanticSearch(validatedDir, query);
      return {
        content: [{ type: "text", text: JSON.stringify(matches, null, 2) }],
      };
    }

    if (name === "start_background_job") {
      const { command, cwd } = StartBackgroundJobSchema.parse(args);
      const cleanCmd = command.trim();
      const validatedCwd = validatePath(cwd);
      const jobId = "job_" + Math.random().toString(36).substring(2, 11);

      let finalCommand = cleanCmd;
      let argsList: string[] = [];

      if (IS_DOCKER_AVAILABLE) {
        const absoluteCwd = path.resolve(validatedCwd);
        const dockerCwd = absoluteCwd.replace(/\\/g, "/");
        // Para rodar em background sob exec, podemos passar direto o comando do Docker
        finalCommand = `docker run --rm -v "${dockerCwd}:/workspace" -w /workspace node:18-alpine sh -c "${cleanCmd.replace(/"/g, '\\"')}"`;
      } else {
        if (!ALLOWED_COMMANDS.includes(cleanCmd)) {
          throw new Error(`Comando background rejeitado por segurança (Docker inativo). No modo local, apenas os seguintes comandos são permitidos: ${ALLOWED_COMMANDS.join(", ")}`);
        }
      }

      await logAudit("start_background_job", { jobId, command: cleanCmd, finalCommand }, sessionId);

      // Inicia o processo assíncrono
      const proc = exec(finalCommand, { cwd: validatedCwd });
      const job: BackgroundJob = {
        id: jobId,
        process: proc,
        status: "running",
        command: cleanCmd,
        logs: []
      };

      backgroundJobs.set(jobId, job);

      proc.stdout?.on("data", (data) => {
        job.logs.push(`[STDOUT] ${data}`);
      });

      proc.stderr?.on("data", (data) => {
        job.logs.push(`[STDERR] ${data}`);
      });

      proc.on("close", (code) => {
        job.status = code === 0 ? "completed" : "failed";
        job.logs.push(`[PROCESS CLOSED] Código de saída: ${code}`);
      });

      return {
        content: [{ type: "text", text: JSON.stringify({ jobId, status: "running" }, null, 2) }],
      };
    }

    if (name === "check_job_status") {
      const { jobId } = CheckJobStatusSchema.parse(args);
      const job = backgroundJobs.get(jobId);
      if (!job) {
        throw new Error(`Job com ID '${jobId}' não encontrado.`);
      }
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            jobId: job.id,
            command: job.command,
            status: job.status,
            logs: job.logs.slice(-100) // Retorna as últimas 100 linhas de logs
          }, null, 2)
        }],
      };
    }

    if (name === "cancel_job") {
      const { jobId } = CancelJobSchema.parse(args);
      const job = backgroundJobs.get(jobId);
      if (!job) {
        throw new Error(`Job com ID '${jobId}' não encontrado.`);
      }
      if (job.status === "running") {
        job.process.kill();
        job.status = "cancelled";
        job.logs.push("[PROCESS KILLED BY USER]");
      }
      await logAudit("cancel_job", { jobId }, sessionId);
      return {
        content: [{ type: "text", text: `Job '${jobId}' cancelado e encerrado com sucesso.` }],
      };
    }

    if (name === "get_audit_logs") {
      const { linesLimit } = GetAuditLogsSchema.parse(args);
      const limit = linesLimit || 50;
      const logPath = path.resolve(process.cwd(), "mcp_audit.log");
      
      try {
        const content = await fs.readFile(logPath, "utf-8");
        const lines = content.trim().split("\n");
        const recent = lines.slice(-limit).map(l => JSON.parse(l));
        return {
          content: [{ type: "text", text: JSON.stringify(recent, null, 2) }],
        };
      } catch (err) {
        return {
          content: [{ type: "text", text: "Nenhum log de auditoria encontrado ainda." }],
        };
      }
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

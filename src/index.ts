import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { promises as fs } from "fs";
import path from "path";

// Instanciando o Servidor MCP
const server = new Server(
  {
    name: "seed-tech-mcp",
    version: "1.1.0",
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
  console.error("Aviso: A variável de ambiente ALLOWED_DIRECTORIES não está definida. O sandbox de segurança está desabilitado.");
} else {
  console.error(`Segurança Sandbox Ativa. Diretórios permitidos: ${ALLOWED_DIRECTORIES.join(", ")}`);
}

/**
 * Valida se o caminho está dentro das pastas permitidas, se aplicável.
 */
function validatePath(targetPath: string): string {
  const resolved = path.resolve(targetPath);
  if (ALLOWED_DIRECTORIES) {
    const isAllowed = ALLOWED_DIRECTORIES.some(dir => resolved.startsWith(dir));
    if (!isAllowed) {
      throw new Error(`Acesso negado: O caminho '${targetPath}' está fora dos diretórios permitidos.`);
    }
  }
  return resolved;
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

// Registrando as ferramentas disponíveis
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "list_directory",
        description: "Lista todos os arquivos e subdiretórios de um diretório, incluindo metadados ricos (tamanho, mtime e extensão).",
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
        description: "Lê o conteúdo em texto de um arquivo específico, com suporte a paginação por linhas.",
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
        description: "Busca arquivos pelo nome, de forma recursiva, dentro de um diretório.",
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
        description: "Busca por conteúdo/texto de forma recursiva dentro de arquivos de texto (grep).",
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
        description: "Cria ou sobrescreve por completo o conteúdo de um arquivo.",
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
        description: "Realiza a edição pontual de um arquivo, substituindo uma string exata e exclusiva por outra.",
        inputSchema: {
          type: "object",
          properties: {
            filePath: { type: "string", description: "Caminho absoluto do arquivo" },
            targetContent: { type: "string", description: "Texto exato a ser substituído" },
            replacementContent: { type: "string", description: "Novo texto substituto" }
          },
          required: ["filePath", "targetContent", "replacementContent"]
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
      const fullPath = path.join(dir, entry.name);
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
      const fullPath = path.join(dir, entry.name);
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
      const entries = await fs.readdir(validatedDir, { withFileTypes: true });
      
      const files = [];
      for (const e of entries) {
        const fullPath = path.join(validatedDir, e.name);
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

      return {
        content: [{ type: "text", text: JSON.stringify(files, null, 2) }],
      };
    }

    if (name === "read_file_content") {
      const { filePath, startLine, endLine } = ReadFileSchema.parse(args);
      const validatedFile = validatePath(filePath);
      const content = await fs.readFile(validatedFile, "utf-8");
      
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
      
      return {
        content: [{ type: "text", text: `Arquivo editado com sucesso. Substituição pontual realizada.` }],
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
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Seed Tech MCP Server rodando via STDIO...");
}

main().catch((error) => {
  console.error("Erro fatal no servidor:", error);
  process.exit(1);
});

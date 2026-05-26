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
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Schemas do Zod para validar argumentos
const ListDirectorySchema = z.object({
  dirPath: z.string().describe("Caminho absoluto do diretório para listar"),
});

const ReadFileSchema = z.object({
  filePath: z.string().describe("Caminho absoluto do arquivo para ler"),
});

const SearchFilesSchema = z.object({
  dirPath: z.string().describe("Caminho absoluto do diretório para buscar"),
  fileNamePattern: z.string().describe("Padrão de nome para buscar (case insensitive)"),
});

// Registrando as ferramentas disponíveis
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "list_directory",
        description: "Lista todos os arquivos e subdiretórios de um determinado diretório.",
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
        description: "Lê o conteúdo em texto de um arquivo específico.",
        inputSchema: {
          type: "object",
          properties: {
            filePath: { type: "string", description: "Caminho absoluto do arquivo" }
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
      }
    ],
  };
});

// Função auxiliar para busca recursiva
async function searchRecursive(dir: string, pattern: string, results: string[] = []) {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      // Verifica se o nome do arquivo/pasta inclui o padrão buscado
      if (entry.name.toLowerCase().includes(pattern.toLowerCase())) {
        results.push(fullPath);
      }
      // Se for diretório, busca dentro dele também
      if (entry.isDirectory()) {
        try {
            await searchRecursive(fullPath, pattern, results);
        } catch(e) {
            // Ignora erros de permissão em subpastas
        }
      }
    }
  } catch (err) {
      // Ignora diretórios inacessíveis
  }
  return results;
}

// Lidando com a execução das ferramentas
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    if (name === "list_directory") {
      const { dirPath } = ListDirectorySchema.parse(args);
      const entries = await fs.readdir(dirPath, { withFileTypes: true });
      const files = entries.map(e => ({
        name: e.name,
        type: e.isDirectory() ? "directory" : "file"
      }));

      return {
        content: [{ type: "text", text: JSON.stringify(files, null, 2) }],
      };
    }

    if (name === "read_file_content") {
      const { filePath } = ReadFileSchema.parse(args);
      const content = await fs.readFile(filePath, "utf-8");
      return {
        content: [{ type: "text", text: content }],
      };
    }

    if (name === "search_files") {
      const { dirPath, fileNamePattern } = SearchFilesSchema.parse(args);
      const results = await searchRecursive(dirPath, fileNamePattern);
      return {
        content: [{ type: "text", text: JSON.stringify(results, null, 2) }],
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

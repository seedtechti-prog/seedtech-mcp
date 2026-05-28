# Seed Tech MCP Server

Um servidor **Model Context Protocol (MCP)** desenvolvido pela **Seed Tech** para expor funcionalidades de leitura, escrita e busca de arquivos locais para assistentes de IA (como o Claude).

## 🛠️ Ferramentas (Tools) Disponíveis

Este servidor expõe as seguintes ferramentas via protocolo MCP usando comunicação padrão (STDIO) ou conexão de rede (SSE):

1. `list_directory`: Lista todos os arquivos e subdiretórios de um determinado diretório absoluto, incluindo metadados ricos como tamanho (`size` em bytes), data de última modificação (`mtime`) e extensão do arquivo. Possui cache automático.
2. `read_file_content`: Lê e retorna o conteúdo em texto de um arquivo específico. Suporta paginação opcional com `startLine` e `endLine` (1-indexed) e possui cache automático.
3. `search_files`: Busca arquivos de forma recursiva pelo nome dentro de uma pasta base (ignora diretórios padrão como `node_modules` e `.git`).
4. `search_file_content`: Busca por conteúdo/texto dentro dos arquivos de forma recursiva (estilo grep) com suporte opcional a filtros de extensão.
5. `write_file`: Cria ou sobrescreve por completo o conteúdo de um arquivo em um caminho seguro (invalida os caches relacionados automaticamente).
6. `edit_file`: Realiza edições parciais seguras, substituindo uma string exata e exclusiva por outra para evitar corromper o arquivo.
7. `read_json_property`: Lê cirurgicamente uma propriedade JSON específica usando notação de ponto (ex: `dependencies.zod`).
8. `update_json_property`: Modifica ou adiciona cirurgicamente uma propriedade em um JSON mantendo formatações.
9. `get_system_info`: Retorna estatísticas de hardware e ambiente operacional (RAM livre/total, versão do Node, CPU, uptime).
10. `run_safe_command`: Executa de forma segura e controlada apenas comandos predefinidos do terminal (`npm test`, `npm run build`, `git status`, `git diff`).

## 🔌 Conexão Híbrida (STDIO & SSE/HTTP)

Este servidor suporta dois meios de comunicação:

### 1. Modo STDIO (Padrão)
Ideal para integrações locais e rápidas (como o aplicativo Claude Desktop). O cliente inicia o processo diretamente e se comunica através da entrada e saída padrão do console.

### 2. Modo HTTP / Server-Sent Events (SSE)
Ideal para expor as ferramentas de forma remota na rede para aplicativos ou agentes baseados na web.
Para iniciar neste modo, defina a porta ou passe a flag `--sse`:
```bash
# Executa via SSE na porta padrão 3000
node build/index.js --sse

# Ou defina uma porta customizada usando variáveis de ambiente
PORT=4000 node build/index.js
```
O endpoint para conexão de rede será disponibilizado em: `http://localhost:3000/sse`.

## 🔒 Segurança (Sandbox e Ignore List)

Este servidor implementa dois níveis de proteção:

1. **Sandbox de Diretórios:** Restrinja o acesso definindo a variável de ambiente `ALLOWED_DIRECTORIES` (separada por `;` ou `,`). Caminhos fora dessas pastas serão recusados.
2. **Ignore List (Lista de Exclusão):** O servidor protege arquivos e pastas sensíveis por padrão:
   * **Pastas ocultadas em listagem/busca:** `node_modules`, `.git`, `.github`, `.vscode`, `dist`, `build`.
   * **Arquivos sensíveis protegidos:** `.env`, `.pem`, `.key`, `id_rsa`, `id_dsa`, `id_ecdsa`, `id_ed25519`.

## ⚡ Cache Inteligente

Para maior velocidade, o conteúdo de arquivos e listagens de diretórios são armazenados temporariamente na memória RAM por **15 segundos** (TTL).
* Qualquer ação de modificação (`write_file`, `edit_file` ou `update_json_property`) invalida instantaneamente o cache correspondente, garantindo consistência total de dados e rapidez absoluta.

## 🚀 Como instalar e rodar localmente

### Pré-requisitos
- [Node.js](https://nodejs.org/) (versão 18 ou superior recomendada)

### Instalação
1. Clone este repositório:
   ```bash
   git clone https://github.com/seedtechti-prog/seedtech-mcp.git
   cd seedtech-mcp
   ```
2. Instale as dependências:
   ```bash
   npm install
   ```
3. Compile o código TypeScript:
   ```bash
   npm run build
   ```

## 🧪 Como testar a aplicação

A maneira mais recomendada de testar as ferramentas visualmente é usando o **MCP Inspector** oficial.

### Testar no modo STDIO:
```bash
npx @modelcontextprotocol/inspector node build/index.js
```

### Testar no modo HTTP/SSE:
Primeiro inicie o servidor com `node build/index.js --sse` em uma janela e, em outra, execute o inspetor apontando para o endpoint:
```bash
npx @modelcontextprotocol/inspector http://localhost:3000/sse
```

## 🔌 Integração com o Claude Desktop

Para integrar o servidor ao seu aplicativo **Claude Desktop**:

1. Abra o arquivo de configuração do Claude. No Windows, ele geralmente fica em `%APPDATA%\Claude\claude_desktop_config.json`.
2. Adicione a seguinte configuração:

```json
{
  "mcpServers": {
    "seed-tech-mcp": {
      "command": "node",
      "args": [
        "C:\\Caminho\\Absoluto\\Ate\\O\\Projeto\\seed-tech-mcp\\build\\index.js"
      ],
      "env": {
        "ALLOWED_DIRECTORIES": "C:\\Caminho\\Absoluto\\Ate\\O\\Projeto"
      }
    }
  }
}
```
*(⚠️ Lembre-se de substituir o caminho nos parâmetros pelo caminho real e usar barras duplas `\\` no Windows. O parâmetro `"env"` é opcional e serve para ativar a sandbox).*

3. Reinicie o Claude Desktop. 

## 📄 Licença
ISC

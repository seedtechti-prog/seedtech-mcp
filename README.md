# Seed Tech MCP Server

Um servidor **Model Context Protocol (MCP)** desenvolvido pela **Seed Tech** de nível empresarial, expondo funcionalidades avançadas de leitura, escrita, compactação, parsing de documentos e execução segura de comandos de terminal com sandbox.

## 🛠️ Ferramentas (Tools) Disponíveis

Este servidor expõe as seguintes ferramentas via protocolo MCP usando comunicação padrão (STDIO) ou conexão de rede (SSE):

1. `list_directory`: Lista todos os arquivos e subdiretórios de um determinado diretório absoluto, com metadados ricos (tamanho em bytes, data de última modificação e extensão). Filtra arquivos sensíveis/ocultos e possui cache em memória (TTL 15s).
2. `read_file_content`: Lê o conteúdo em texto de um arquivo específico. Suporta paginação opcional (`startLine` e `endLine`) e possui cache em memória.
3. `search_files`: Busca arquivos de forma recursiva pelo nome (ignora automaticamente diretórios padrão como `node_modules` e `.git`).
4. `search_file_content`: Busca por conteúdo/texto dentro dos arquivos de forma recursiva (estilo grep) com suporte a filtros de extensão (ignora arquivos binários e sensíveis).
5. `write_file`: Cria ou sobrescreve por completo o conteúdo de um arquivo em um caminho seguro (limpa caches automaticamente).
6. `edit_file`: Realiza edições parciais seguras, substituindo uma string exata e exclusiva por outra para evitar corromper o arquivo (limpa caches).
7. `read_json_property`: Lê cirurgicamente uma propriedade JSON específica usando notação de ponto (ex: `dependencies.zod`).
8. `update_json_property`: Modifica ou adiciona cirurgicamente uma propriedade em um JSON mantendo formatações (limpa caches).
9. `get_system_info`: Retorna diagnósticos de hardware e ambiente operacional (RAM livre/total, versão do Node, CPU, uptime).
10. `run_safe_command`: Executa comandos do terminal. Se o **Docker** estiver ativo, roda de forma 100% isolada e segura em um sandbox completo. Se inativo, entra em fallback restrito a uma lista de comandos locais aprovados.
11. `zip_directory`: Compacta um diretório completo em um arquivo `.zip`.
12. `unzip_file`: Extrai e descompacta por completo um arquivo `.zip` para uma pasta de destino.
13. `read_pdf_text`: Lê e extrai todo o conteúdo de texto formatado de arquivos PDF locais.

## 🐳 Docker Command Sandbox

A ferramenta `run_safe_command` implementa uma arquitetura híbrida inteligente:
* **Com Docker ativo (Recomendado):** Qualquer comando solicitado pela IA será executado dentro de um contêiner Docker temporário e descartável (`node:18-alpine`), com o diretório montado em `/workspace`. Isso garante **isolamento total** e segurança absoluta para rodar testes, scripts Python ou Node arbitrários.
* **Com Docker inativo (Fallback):** O servidor executa localmente no host, porém restringindo estritamente a execução apenas a comandos pré-aprovados (`npm test`, `npm run build`, `git status`, `git diff`) bloqueando qualquer outro input.

## 🔒 Segurança (Sandbox de Pastas, Ignore List & API Key)

O servidor implementa proteção avançada em 3 camadas:
1. **Sandbox de Diretórios:** Bloqueia qualquer leitura ou escrita fora dos caminhos declarados na variável de ambiente `ALLOWED_DIRECTORIES` (caminhos separados por `;`).
2. **Ignore List (Lista de Exclusão):** O servidor protege arquivos e pastas sensíveis por padrão:
   * **Pastas ocultadas em listagem/busca:** `node_modules`, `.git`, `.github`, `.vscode`, `dist`, `build`.
   * **Arquivos sensíveis protegidos:** `.env`, `.pem`, `.key`, `id_rsa`, `id_dsa`, `id_ecdsa`, `id_ed25519`.
3. **Autenticação via API Key:** Proteja as conexões HTTP/SSE declarando a variável de ambiente `MCP_API_KEY`. O servidor exigirá o cabeçalho `X-API-Key` ou parâmetro `?apiKey=...` para autenticar clientes.

## 🔌 Conexão Híbrida (STDIO & SSE Multi-Session)

Este servidor suporta dois meios de comunicação simultâneos:

### 1. Modo STDIO (Padrão)
Ideal para conexões locais rápidas (como o Claude Desktop). O cliente inicia o processo diretamente.

### 2. Modo HTTP / Server-Sent Events (SSE) com Múltiplas Sessões
Ideal para integrar agentes remotos e web simultaneamente. O servidor gerencia de forma concorrente múltiplas conexões independentes por IDs de sessão:
```bash
# Inicia em modo de rede SSE na porta padrão 3000
node build/index.js --sse

# Ou defina a porta e a chave de API
PORT=4000 MCP_API_KEY=suachavesecreta node build/index.js
```
* **Endpoint de Streaming:** `http://localhost:3000/sse?sessionId=seu_agente_1`
* **Endpoint de Mensagens:** `http://localhost:3000/messages?sessionId=seu_agente_1`

## ⚡ Cache Inteligente
Para maior velocidade, o conteúdo de arquivos e listagens de diretórios são armazenados temporariamente na memória RAM por **15 segundos** (TTL) com invalidação automática sob qualquer evento de gravação.

## 🚀 Como instalar e rodar localmente

### Pré-requisitos
- [Node.js](https://nodejs.org/) (versão 18 ou superior recomendada)
- **Docker Desktop** (opcional, para habilitar a sandbox de comandos isolada)

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
Primeiro inicie o servidor com `node build/index.js --sse` em uma janela e, em outra, execute o inspetor apontando para o endpoint correspondente:
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

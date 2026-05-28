# Seed Tech MCP Server

Um servidor **Model Context Protocol (MCP)** desenvolvido pela **Seed Tech** de nível enterprise e extremamente avançado, expondo funcionalidades completas de leitura, escrita, compactação, banco de dados SQLite, busca semântica inteligente, logs de auditoria e execução isolada de comandos de terminal com sandbox.

## 🛠️ Ferramentas (Tools) Disponíveis

Este servidor expõe **20 ferramentas** via protocolo MCP usando comunicação padrão (STDIO) ou conexão de rede (SSE):

### Manipulação de Arquivos e Pastas
1. `list_directory`: Lista todos os arquivos e subdiretórios de um determinado diretório absoluto, com metadados ricos (tamanho em bytes, data de modificação e extensão). Oculta pastas sensíveis e possui cache automático (TTL 15s).
2. `read_file_content`: Lê o conteúdo em texto de um arquivo específico. Suporta paginação opcional (`startLine` e `endLine`) e possui cache automático.
3. `search_files`: Busca arquivos de forma recursiva pelo nome (ignora pastas comuns como `node_modules` e `.git`).
4. `search_file_content`: Busca por conteúdo/texto dentro dos arquivos de forma recursiva (estilo grep) com suporte a filtros de extensão (ignora arquivos binários e sensíveis).
5. `write_file`: Cria ou sobrescreve por completo o conteúdo de um arquivo em um caminho seguro (limpa caches e registra auditoria automaticamente).
6. `edit_file`: Realiza edições parciais seguras, substituindo uma string exata e exclusiva por outra para evitar corromper o arquivo (limpa caches e gera auditoria).

### Integração com JSON e Documentos
7. `read_json_property`: Lê cirurgicamente uma propriedade JSON específica usando notação de ponto (ex: `dependencies.zod`).
8. `update_json_property`: Modifica ou adiciona cirurgicamente uma propriedade em um JSON mantendo formatações (limpa caches e gera auditoria).
9. `read_pdf_text`: Lê e extrai todo o conteúdo de texto formatado de arquivos PDF locais.

### Compactação de Arquivos
10. `zip_directory`: Compacta um diretório completo em um arquivo `.zip`.
11. `unzip_file`: Extrai e descompacta por completo um arquivo `.zip` para uma pasta de destino.

### Consultas a Banco de Dados e Web
12. `query_sqlite`: Executa de forma segura e somente-leitura consultas SQL `SELECT` em bancos de dados SQLite locais (`.db` ou `.sqlite`).
13. `fetch_web_content`: Faz requisições HTTP GET seguras para ler documentações ou baixar dados direto da internet.

### Busca Semântica Avançada
14. `search_semantic`: Realiza busca semântica conceitual inteligente nos arquivos do projeto usando um algoritmo local de NLP (TF-IDF) nativo em JavaScript.

### Execução de Comandos e Tarefas em Background
15. `run_safe_command`: Executa comandos do terminal de forma síncrona. Se o **Docker** estiver ativo, roda em sandbox 100% isolado. Se inativo, entra em fallback restrito.
16. `start_background_job`: Inicia a execução de um comando longo do terminal em segundo plano (em background), retornando um ID exclusivo para evitar timeouts no cliente MCP.
17. `check_job_status`: Retorna o progresso, status atual e logs acumulados (stdout/stderr) em tempo real do job em background.
18. `cancel_job`: Interrompe e finaliza imediatamente um job em background em execução.

### Diagnósticos e Auditoria de Segurança
19. `get_system_info`: Retorna estatísticas de hardware e ambiente operacional (RAM livre/total, versão do Node, CPU, uptime).
20. `get_audit_logs`: Recupera os registros estruturados persistidos do arquivo local de auditoria (`mcp_audit.log`).

## 🐳 Docker Command Sandbox

A ferramenta `run_safe_command` e os background jobs implementam uma arquitetura híbrida inteligente:
* **Com Docker ativo (Recomendado):** Qualquer comando solicitado será executado dentro de um contêiner Docker temporário e descartável (`node:18-alpine`), com o diretório montado em `/workspace`. Isso garante **isolamento total** e segurança absoluta para rodar testes ou códigos.
* **Com Docker inativo (Fallback):** O servidor executa localmente no host, porém restringindo estritamente a execução apenas a comandos pré-aprovados (`npm test`, `npm run test`, `npm run build`, `git status`, `git diff`) bloqueando qualquer outro input.

## 🔒 Segurança e Auditoria

1. **Sandbox de Diretórios:** Restringe leituras e escritas apenas aos caminhos declarados na variável de ambiente `ALLOWED_DIRECTORIES`.
2. **Logs de Auditoria estruturados (`mcp_audit.log`):** Grava de forma persistente cada ação sensível executada pelas ferramentas (gravações, edições, queries SQL, comandos iniciados), garantindo total transparência do que a IA realizou.
3. **Autenticação via API Key:** Exige o header `X-API-Key` ou parâmetro `?apiKey=...` se você definir a variável de ambiente `MCP_API_KEY`.

## 🔌 Conexão Híbrida (STDIO & SSE Multi-Session)

* **Modo STDIO (Padrão):** Ideal para conexões locais rápidas (como o Claude Desktop).
* **Modo HTTP / Server-Sent Events (SSE):** Permite conexões remotas concorrentes gerenciando múltiplas conexões independentes por IDs de sessão:
```bash
# Inicia via SSE na porta 3000
node build/index.js --sse
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

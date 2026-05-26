# Seed Tech MCP Server

Um servidor **Model Context Protocol (MCP)** desenvolvido pela **Seed Tech** para expor funcionalidades de leitura e busca de arquivos locais para assistentes de IA (como o Claude).

## 🛠️ Ferramentas (Tools) Disponíveis

Este servidor expõe as seguintes ferramentas via protocolo MCP usando comunicação padrão (STDIO):

1. `list_directory`: Lista todos os arquivos e subdiretórios de um determinado diretório absoluto.
2. `read_file_content`: Lê e retorna o conteúdo em texto de um arquivo específico.
3. `search_files`: Busca arquivos de forma recursiva pelo nome dentro de uma pasta base.

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
A partir da raiz da pasta do projeto, execute:

```bash
npx @modelcontextprotocol/inspector node build/index.js
```
Uma URL será gerada no terminal (ex: `http://localhost:5173`). Abra no seu navegador, clique em "Connect" e você poderá testar todas as ferramentas diretamente por uma interface gráfica.

## 🔌 Integração com o Claude Desktop

Para integrar o servidor ao seu aplicativo **Claude Desktop** e permitir que a IA leia seus arquivos:

1. Abra o arquivo de configuração do Claude. No Windows, ele geralmente fica em `%APPDATA%\Claude\claude_desktop_config.json`.
2. Adicione a seguinte configuração:

```json
{
  "mcpServers": {
    "seed-tech-mcp": {
      "command": "node",
      "args": [
        "C:\\Caminho\\Absoluto\\Ate\\O\\Projeto\\seed-tech-mcp\\build\\index.js"
      ]
    }
  }
}
```
*(⚠️ Lembre-se de substituir o caminho no parâmetro `args` pelo caminho real de onde a pasta do projeto está salva no seu computador e usar barras duplas `\\` no Windows)*.

3. Reinicie o Claude Desktop. 

Quando você abrir uma conversa com o Claude, verá um ícone de "Martelo/Ferramenta", indicando que as ferramentas locais da Seed Tech foram carregadas com sucesso!

## 📄 Licença
ISC

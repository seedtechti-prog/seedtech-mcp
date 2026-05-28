# Seed Tech MCP Server

Um servidor **Model Context Protocol (MCP)** desenvolvido pela **Seed Tech** para expor funcionalidades de leitura, escrita e busca de arquivos locais para assistentes de IA (como o Claude).

## 🛠️ Ferramentas (Tools) Disponíveis

Este servidor expõe as seguintes ferramentas via protocolo MCP usando comunicação padrão (STDIO):

1. `list_directory`: Lista todos os arquivos e subdiretórios de um determinado diretório absoluto, incluindo metadados ricos como tamanho (`size` em bytes), data de última modificação (`mtime`) e extensão do arquivo.
2. `read_file_content`: Lê e retorna o conteúdo em texto de um arquivo específico. Suporta paginação opcional com `startLine` e `endLine` (1-indexed).
3. `search_files`: Busca arquivos de forma recursiva pelo nome dentro de uma pasta base.
4. `search_file_content`: Busca por conteúdo/texto dentro dos arquivos de forma recursiva (estilo grep) com suporte opcional a filtros de extensão.
5. `write_file`: Cria ou sobrescreve por completo o conteúdo de um arquivo em um caminho seguro.
6. `edit_file`: Realiza edições parciais seguras, substituindo uma string exata e exclusiva por outra para evitar corromper o arquivo.

## 🔒 Segurança (Sandbox de Diretórios)

Para maior segurança, você pode restringir o acesso do servidor a diretórios específicos definindo a variável de ambiente `ALLOWED_DIRECTORIES`:

* Se estiver definida (ex: `C:\Projetos;D:\Documentos`), o servidor validará todos os caminhos e impedirá o acesso de leitura ou escrita a qualquer local fora das pastas autorizadas.
* Se não estiver definida, o servidor rodará em modo permissivo (emite um aviso de sandbox desabilitado no console de erros).

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

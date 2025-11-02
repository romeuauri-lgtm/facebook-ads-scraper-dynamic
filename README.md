# 🧠 Facebook Ads Library Dynamic Scraper

Este Actor coleta anúncios da **Meta Ads Library (Facebook Ads Library)** com base em uma *keyword*, país, tipo de anúncio e intervalo de datas.  
É ideal para **pesquisa de produtos, análise de campanhas e benchmarking de concorrência**.

---

## 🚀 Como funciona

O Actor usa **Playwright + Crawlee** para carregar dinamicamente a biblioteca de anúncios e extrair dados reais, inclusive texto, mídia e página anunciante.

Durante a execução:
- Carrega a URL da Meta Ads Library com os filtros especificados.
- Faz scroll automático e coleta até `maxResults` anúncios.
- Salva os resultados no dataset da execução (`Dataset` tab).

---

## ⚙️ Parâmetros de entrada

| Campo        | Tipo    | Padrão       | Descrição |
|---------------|----------|--------------|------------|
| `keyword`     | string   | —            | Palavra-chave ou nome do produto para pesquisa. *(Obrigatório)* |
| `country`     | string   | `ALL`        | Código ISO2 do país (ex: `ES`, `IT`, `FR`, `ALL` para global). |
| `maxResults`  | integer  | `50`         | Quantidade máxima de anúncios a extrair. |
| `adType`      | string   | `ACTIVE`     | Tipo de anúncio: `ACTIVE`, `INACTIVE` ou `ALL`. |
| `language`    | string   | `en`         | Idioma preferido da interface dos anúncios (ex: `en`, `es`, `pt`). |
| `startDate`   | string   | `2018-01-01` | Data inicial de filtragem no formato `YYYY-MM-DD`. |
| `endDate`     | string   | *(hoje)*     | Data final da filtragem no formato `YYYY-MM-DD`. |

---

## 🧩 Exemplo de input JSON

```json
{
  "keyword": "massager neck electric",
  "country": "ES",
  "maxResults": 20,
  "adType": "ACTIVE",
  "language": "es",
  "startDate": "2019-01-01",
  "endDate": "2025-11-02"
}

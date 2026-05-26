# 🔐 Kitchen Flow - Guia de Segurança e Acesso

Este documento explica como garantir que apenas pessoas autorizadas acessem o sistema Kitchen Flow.

---

## 🎯 Objetivo

Garantir que:
- ✅ Apenas dispositivos **dentro do restaurante** acessem a página do garçom
- ✅ Apenas garçons **escalados no dia** tenham o código de acesso
- ✅ O sistema **não funcione fora do local** sem autorização

---

## 🔧 Camada 1: PIN Diário (Já Implementado)

### Como Funciona
- Um código de **4 dígitos** é necessário para acessar `waiter.html`
- O código **muda todo dia** automaticamente
- A gerente pode definir manualmente pelo menu do Bridge

### Para a Gerente Definir o PIN
1. Clique no ícone do Kitchen Flow na bandeja do Windows (perto do relógio)
2. Selecione **"🔑 Definir PIN do Garçom"**
3. Digite 4 números (ex: `2505`)
4. ✅ O sistema valida que não é repetição dos últimos 7 dias
5. ✅ O PIN aparece na tela principal do Bridge para repassar à equipe

### Para o Garçom Acessar
1. Conectar o celular na rede Wi-Fi do restaurante
2. Abrir o navegador e acessar: `http://IP-DO-PC:4545/waiter.html`
3. Digitar o PIN do dia quando solicitado
4. ✅ Acesso concedido por 24 horas

### Regras de Segurança do PIN
| Regra | Por que é importante |
|-------|---------------------|
| 4 dígitos exatos | Fácil de digitar, difícil de adivinhar |
| Não repete o PIN de ontem | Evita "preguiça mental" de reusar código |
| Não repete nenhum dos últimos 7 dias | Garante variedade e segurança básica |
| Expira à meia-noite | Garante renovação diária automática |
| Máscara na UI (**XX) | Previne que alguém veja por trás |

---

## 🔧 Camada 2: Acesso Apenas na Rede Local (Recomendado)

### Por que Configurar?
Por padrão, o Kitchen Flow escuta na porta `4545` do PC do caixa. 
**Qualquer dispositivo na mesma rede Wi-Fi pode acessar** se souber o IP e o PIN.

Para maior segurança, configure o roteador para **bloquear acesso externo**.

### Passo a Passo para Roteadores Comuns

#### 🔹 TP-Link / Intelbras / D-Link
1. Acesse o roteador: `192.168.0.1` ou `192.168.1.1` (veja no manual)
2. Vá em **Firewall** → **Controle de Acesso** ou **Regras de Porta**
3. Crie uma nova regra:

| Campo | Valor |
|-------|-------|
| Nome da Regra | Kitchen Flow - Acesso Local |
| Porta | `4545`, `4546` |
| Protocolo | `TCP` |
| Origem (Source) | **LAN** (Rede Local) |
| Destino (Destination) | IP do PC do Caixa (ex: `192.168.1.100`) |
| Ação | **PERMITIR** |

4. Crie uma segunda regra para bloquear o resto:

| Campo | Valor |
|-------|-------|
| Nome da Regra | Kitchen Flow - Bloquear Externo |
| Porta | `4545`, `4546` |
| Protocolo | `TCP` |
| Origem (Source) | **WAN** (Internet) |
| Ação | **BLOQUEAR** |

5. Salve e reinicie o roteador.

#### 🔹 Roteador com VLAN (Avançado)
Se seu roteador suportar múltiplas redes:
1. Crie uma VLAN chamada **"ADM"** para dispositivos autorizados
2. Conecte o PC do caixa e os celulares dos garçons nesta VLAN
3. Aplique as regras acima apenas para a VLAN "ADM"

---

## 📱 Como Testar a Restrição

### Teste 1: Dentro da Rede "ADM" (Deve Funcionar)
```bash
# No celular do garçom, conectado na rede do restaurante:
1. Abrir navegador
2. Acessar: http://192.168.1.100:4545/waiter.html
3. Digitar PIN do dia
4. ✅ Deve carregar a página de pedidos
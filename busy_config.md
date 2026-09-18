# ⚡ BUSY Accounting Software WhatsApp Configuration Guide

This guide describes how to configure **BUSY Accounting Software** to automatically send invoices, receipts, and outstanding reminders via the **WA Sender** local API server.

---

## 🛠️ Step-by-Step Configuration in BUSY

Follow these steps to set up the WhatsApp API integration:

1. Open **BUSY Accounting Software** and navigate to:
   `Administration` ➔ `Configuration` ➔ `SMS/WhatsApp Configuration`.

2. Set the configuration options exactly as shown below:

| Field | Configuration Value | Description |
| :--- | :--- | :--- |
| **Format Name** | `WA` | Name of the format structure (user-defined). |
| **Send PDF link for Invoice** | ☑️ **Checked** | Automatically exports and attaches the invoice PDF file to the WhatsApp message. |
| **Server Type** | 🟢 **Service Provider Server** | Select this radio button. |
| **WhatsApp/SMS API** | `http://localhost:5000/api/v1/send?` | The base endpoint of your local WA Sender server. |

---

## 📋 Parameter Mapping

Under the parameters section, define the mapping exactly as follows (note that names are **case-sensitive**):

| Parameter Name | Parameter Value | Behavior |
| :--- | :--- | :--- |
| `Mobile` | *(To be picked while sending)* | Maps the debtor's phone number to the API query string. |
| `Message` | *(To be picked while sending)* | Maps the generated message template to the API query string. |
| **No. of Other Parameters** | `0` | Set this to `0` (or `1` if using multi-account, see pro-tip below). |

---

## 📱 Mobile Number Treatment (Critical for Delivery)

To ensure messages are sent to standard formatting (with the `91` country code for India):

*   **Treatment of Mobile Number:** Select **`Truncate with Prefix`**
*   **Mobile number Length:** `10`
*   **Prefix:** `91`

*This strips any leading zeros or local area codes and ensures the number is sent to the API as a 12-digit number (e.g., `91XXXXXXXXXX`).*

---

## 💡 Pro-Tips

### 1. Multi-Account Rotation / Specific Account Targeting
If you have multiple WhatsApp accounts linked in WA Sender and want a specific BUSY terminal to send messages via a specific account:
1. Increase **No. of Other Parameters** to `1`.
2. Add a new parameter:
   * **Parameter Name:** `whatsappClientId`
   * **Parameter Value:** `your_connection_id` (e.g. `billing`, `sales`, or the generated connection name).

### 2. Auto-Attachment Cleanup
All PDFs exported by BUSY to the server's directory are automatically queued, sent, and kept in a secure cache folder. The WA Sender server will automatically clean up invoice PDFs older than **15 days** to free up disk space.

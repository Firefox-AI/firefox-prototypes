import { html, css } from "chrome://global/content/vendor/lit.all.mjs";
import { MozLitElement } from "chrome://global/content/lit-utils.mjs";

/**
 * A custom element that renders a combined button and select dropdown for CTA actions.
 */
export class CombinedButtonSelect extends MozLitElement {
  static properties = {
    selectedValue: { type: String },
    options: { type: Array },
    disabled: { type: Boolean }
  };

  constructor() {
    super();
    this.selectedValue = "";
    this.options = [
      { value: "chat", label: "Chat" },
      { value: "search", label: "Search" },
      { value: "navigate", label: "Navigate" },
      { value: "action", label: "Action" }
    ];
    this.disabled = false;
  }

  get buttonLabel() {
    const selectedOption = this.options.find(option => option.value === this.selectedValue);
    return selectedOption ? selectedOption.label : "→";
  }

  handleSubmit() {
    if (this.disabled) {
      return;
    }

    this.dispatchEvent(new CustomEvent("submit", {
      detail: {
        value: this.selectedValue,
      },
      bubbles: true,
      composed: true
    }));
  }

  handleSelectionChange(e) {
    const newValue = e.target.value;
    const oldValue = this.selectedValue;
    this.selectedValue = newValue;

    this.dispatchEvent(new CustomEvent("selection-change", {
      detail: {
        value: newValue,
        oldValue,
      },
      bubbles: true,
      composed: true
    }));
  }

  render() {
    return html`
      <div class="combined-container">
        <button
          class="cta-button"
          @click=${this.handleSubmit}
          ?disabled=${this.disabled || !this.selectedValue}
          title="Submit"
        >
          <span class="button-label">${this.buttonLabel}</span>
        </button>
      ${this.selectedValue ? html`
        <select
          class="query-select"
          @change=${this.handleSelectionChange}
          ?disabled=${this.disabled}
        >
          ${this.options.map(option => html`
            <option
              value=${option.value}
              ?selected=${option.value === this.selectedValue}
            >
              ${option.label}
            </option>
          `)}
        </select>
      ` : ''}
      </div>
    `;
  }

  static styles = css`
    :host {
      display: inline-flex;
      position: relative;
    }

    .combined-container {
      background: linear-gradient(260deg, rgba(255, 183, 148, 0.8) -49.13%, rgba(181, 62, 175, 0.8) 63.71%, rgba(131, 62, 181, 0.8) 128.68%);
      border-radius: 24px;
      display: flex;
      min-height: var(--button-min-height, 32px);
      overflow: hidden;
    }

    .combined-container:has(.cta-button:disabled) {
      background: rgba(180, 99, 190, 0.3);
    }

    .cta-button {
      align-items: center;
      background: none;
      border: none;
      color: white;
      cursor: pointer;
      display: flex;
      font-size: 16px;
      justify-content: center;
      padding: 0 var(--space-xsmall) 0 var(--space-medium);
      min-width: 50px;
    }

    .cta-button:hover:not(:disabled) {
      background: rgba(0, 0, 0, 0.1);
    }

    .cta-button:disabled {
      cursor: not-allowed;
      padding: 0 var(--space-medium);
    }

    .query-select {
      border: none;
      background: transparent;
      background-image: url("data:image/svg+xml;charset=UTF-8,%3csvg width='16' height='16' viewBox='0 0 16 16' fill='none' xmlns='http://www.w3.org/2000/svg'%3e%3cpath d='M8.35201 10.9992L13.818 5.53415C13.8762 5.47618 13.9224 5.40727 13.9539 5.33137C13.9854 5.25548 14.0016 5.17411 14.0015 5.09194C14.0014 5.00978 13.985 4.92845 13.9534 4.85262C13.9217 4.7768 13.8754 4.70799 13.817 4.65015C13.6994 4.53333 13.5403 4.46777 13.3745 4.46777C13.2087 4.46777 13.0497 4.53333 12.932 4.65015L7.99801 9.58515L3.06801 4.65115C2.94964 4.53877 2.79207 4.47707 2.62887 4.47918C2.46567 4.4813 2.30975 4.54707 2.19434 4.66248C2.07893 4.77789 2.01316 4.93381 2.01104 5.09701C2.00892 5.26021 2.07063 5.41779 2.18301 5.53615L7.64801 11.0002L8.35201 10.9992Z' fill='white'/%3e%3c/svg%3e");
      background-repeat: no-repeat;
      background-position: 35% 60%;
      background-size: 20px 20px;
      color: transparent;
      cursor: pointer;
      width: 32px;
      min-width: 32px;
      text-indent: -9999px;
      outline: none;
      appearance: none;
    }

    .query-select:hover:not(:disabled) {
      background-color: rgba(0, 0, 0, 0.1);
    }

    .query-select:disabled {
      background: #e5e7eb;
      color: #9ca3af;
      cursor: not-allowed;
    }

    .query-select:focus {
      background-color: rgba(0, 0, 0, 0.1);
    }
  `;
}

customElements.define("combined-button-select", CombinedButtonSelect);

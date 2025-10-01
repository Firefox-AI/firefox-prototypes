import { html, css } from "chrome://global/content/vendor/lit.all.mjs";
import { MozLitElement } from "chrome://global/content/lit-utils.mjs";

function ellipsis(text, maxLength) {
  if (text.length <= maxLength) return text
  return text.slice(0, maxLength - 1) + '…'
}

class MentionChip extends MozLitElement {
  constructor() {
    super()
    this.option = { type: '', value: '' }
  }

  static get properties() {
    return {
      option: { type: Object },
    }
  }

  render() {
    return html`
      <span class=${`mention ${this.option.type}`} contenteditable="false">
        ${this.option.type === 'tab' && this.option.image
          ? html`<img
              class="favicon"
              src=${this.option.image}
              alt=${this.option.value}
              width="14"
              height="14"
            />`
          : ''}
        ${this.option.type === 'user' ? '@' : ''}
        ${ellipsis(this.option.value, 20)}
      </span>
    `
  }

  static styles = css`
    :host {
      display: inline;
      white-space: nowrap;
      margin: 0;
      padding: 0;
      vertical-align: baseline;
      font-size: 16px;
    }

    .mention {
      display: inline-flex;
      align-items: center;
      gap: 4px;
            border-radius: 4px;

      font-weight: 500;
      padding: 4px;
      line-height: 1;
      margin: 0 -2px;
    }

    .mention.user {
      background: #df9960;
      color: white;
    }

    .mention.tab {
      background: #55c8e8;
      color: #3a3a3a;
    }
  `
}

customElements.define('mention-chip', MentionChip)

/** @param {{ type: string, value: string, image?: string }} option */
function createMentionChip(option) {
  const chip = document.createElement('mention-chip')
  chip.option = option
  chip.setAttribute('data-type', option.type)
  chip.setAttribute('data-value', option.value)
  return chip
}

function textNode(string = '') {
  return document.createTextNode(string)
}

function currentRange() {
  const selection = window.getSelection()
  return selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null
}

function setCaret(node, offset) {
  const range = document.createRange()
  range.setStart(node, offset)
  range.collapse(true)

  const selection = window.getSelection()
  selection?.removeAllRanges()
  selection?.addRange(range)
}

const isTextNode = (node) => !!node && node.nodeType === Node.TEXT_NODE
const isElementNode = (node) => !!node && node.nodeType === Node.ELEMENT_NODE
const isMentionElement = (node) =>
  !!node && isElementNode(node) && node.nodeName === 'MENTION-CHIP'
const removeDomNode = (node) => {
  node?.parentNode?.removeChild(node)
}

function matchAtTriggerInText(text, caretOffset) {
  const mentionPattern = /@(\w*)$/
  const before = text.slice(0, caretOffset)
  return before.match(mentionPattern)
}

export class MentionInput extends MozLitElement {
  constructor() {
    super()
    this.placeholder = 'Type something...'
    this.mentionOptions = []
    this._filteredMentionOptions = [...this.mentionOptions]
    this._selectedIndex = -1
    this._showMentions = false
  }

  static get properties() {
    return {
      placeholder: { type: String },
      mentionOptions: { type: Array },
      _filteredMentionOptions: { type: Array, state: true },
      _selectedIndex: { type: Number, state: true },
      _showMentions: { type: Boolean, state: true },
    }
  }

  get editableSection() {
    return this.renderRoot.querySelector('.mention-input')
  }

  firstUpdated() {
    const element = this.editableSection
    if (!element) return

    this._onKeyDown = (e) => this.handleKeyDown(e)
    element.addEventListener('keydown', this._onKeyDown)
  }

  disconnectedCallback() {
    const el = this.editableSection
    if (el && this._onKeyDown) {
      el.removeEventListener('keydown', this._onKeyDown)
    }
    super.disconnectedCallback()
  }

  handleBackspace(event, anchorNode, anchorOffset) {
    if (isMentionElement(anchorNode)) {
      event.preventDefault()
      removeDomNode(anchorNode)
      return
    }

    if (isTextNode(anchorNode) && anchorOffset === 0) {
      const prevSibling = anchorNode.previousSibling
      if (isMentionElement(prevSibling)) {
        event.preventDefault()
        removeDomNode(prevSibling)
      }
      return
    }

    if (isTextNode(anchorNode) && anchorOffset > 0) {
      const textBeforeCaret = anchorNode.textContent?.slice(0, anchorOffset)
      const spacePattern = /^$/
      if (!textBeforeCaret?.match(spacePattern)) {
        return
      }

      const prevSibling = anchorNode.previousSibling
      if (!isMentionElement(prevSibling)) {
        return
      }

      event.preventDefault()
      removeDomNode(prevSibling)
      setCaret(anchorNode, 0)
    }
  }

  handleDelete(event, anchorNode, anchorOffset) {
    if (!isTextNode(anchorNode)) return
    const textContent = anchorNode.textContent ?? ''
    if (anchorOffset !== textContent.length) return

    const nextSibling = anchorNode.nextSibling
    if (!isMentionElement(nextSibling)) return

    event.preventDefault()
    removeDomNode(nextSibling)
  }

  handleArrowLeft(event, anchorNode, anchorOffset) {
    if (!isTextNode(anchorNode)) return

    // Caret is at the start of a text node
    if (anchorOffset === 0) {
      const prevSibling = anchorNode.previousSibling
      if (isMentionElement(prevSibling)) {
        event.preventDefault()

        // If there's a text node before the chip, place caret there
        if (prevSibling.previousSibling && isTextNode(prevSibling.previousSibling)) {
          const beforeText = prevSibling.previousSibling
          setCaret(beforeText, beforeText.textContent.length)
        } else {
          // Otherwise, insert a safe empty text node before the chip
          const text = textNode('')
          prevSibling.parentNode.insertBefore(text, prevSibling)
          setCaret(text, 0)
        }
      }
    }
  }

  handleArrowRight(event, anchorNode, anchorOffset) {
    if (!isTextNode(anchorNode)) return

    const textContent = anchorNode.textContent ?? ''
    // Caret is at the end of a text node
    if (anchorOffset === textContent.length - 1) {
      const nextSibling = anchorNode.nextSibling
      // If the *next* node is a chip, skip over it
      if (isMentionElement(nextSibling)) {
        event.preventDefault()

        // Place caret in a safe text node after the chip
        if (nextSibling.nextSibling && isTextNode(nextSibling.nextSibling)) {
          setCaret(nextSibling.nextSibling, 0)
        } else {
          // Create a placeholder text node if nothing follows
          const text = textNode('')
          nextSibling.parentNode.insertBefore(text, nextSibling.nextSibling)
          setCaret(text, 0)
        }
      }
    }
  }

  handleArrowDown(event) {
    event.preventDefault()
    if (this._selectedIndex === this._filteredMentionOptions.length - 1) {
      this._selectedIndex = 0
      return
    }
    this._selectedIndex = Math.min(
      this._selectedIndex + 1,
      this._filteredMentionOptions.length - 1,
    )
  }

  handleArrowUp(event) {
    event.preventDefault()
    if (this._selectedIndex === 0) {
      this._selectedIndex = this._filteredMentionOptions.length - 1
      return
    }
    this._selectedIndex = Math.max(this._selectedIndex - 1, 0)
  }

  handleEnter(event) {
    event.preventDefault()
    if (!this._showMentions) {
      this.handleSubmit()
      return
    }

    if (this._selectedIndex >= 0) {
      this.selectMention(this._filteredMentionOptions[this._selectedIndex])
    }
  }

  handleEscape(event) {
    event.preventDefault()
    this._showMentions = false
    this._selectedIndex = -1
  }

  handleKeyDown(event) {
    const editableSection = this.editableSection
    if (!editableSection) return

    const selection = window.getSelection()
    const anchorNode = selection?.anchorNode
    const anchorOffset = selection?.anchorOffset ?? 0
    if (!anchorNode) return

    const keyMap = {
      Backspace: () => this.handleBackspace(event, anchorNode, anchorOffset),
      Delete: () => this.handleDelete(event, anchorNode, anchorOffset),
      ArrowDown: () => this.handleArrowDown(event),
      ArrowUp: () => this.handleArrowUp(event),
      ArrowLeft: () => this.handleArrowLeft(event, anchorNode, anchorOffset),
      ArrowRight: () => this.handleArrowRight(event, anchorNode, anchorOffset),
      Enter: () => this.handleEnter(event),
      Escape: () => this.handleEscape(event),
    }

    keyMap[event.key]?.()
  }

  getMentionFilterText() {
    const selectRange = currentRange()
    let filterText = ''
    let show = false

    if (selectRange && selectRange.startContainer.nodeType === Node.TEXT_NODE) {
      const match = matchAtTriggerInText(
        selectRange.startContainer.textContent ?? '',
        selectRange.startOffset,
      )
      if (match) {
        show = true
        filterText = match[1]
      }
    }

    return { filterText, show }
  }

  handleInput = () => {
    const { filterText, show } = this.getMentionFilterText()

    if (show) {
      this._filteredMentionOptions = this.mentionOptions.filter((option) =>
        option.value.toLowerCase().startsWith(filterText.toLowerCase()),
      )
      this._selectedIndex = this._filteredMentionOptions.length > 0 ? 0 : -1
    } else {
      this._filteredMentionOptions = [...this.mentionOptions]
      this._selectedIndex = -1
    }

    this._showMentions = show
  }

  handleMentionClick = (e) => {
    const target = e.currentTarget
    e.preventDefault()
    e.stopPropagation()

    if (target.nextSibling) {
      setCaret(target.nextSibling, 0)
      return
    }

    const text = textNode('')
    target.parentNode?.insertBefore(text, target.nextSibling)
    setCaret(text, 0)
  }

  selectMention = (option) => {
    const editableSection = this.editableSection
    const selectRange = currentRange()
    if (!editableSection || !selectRange) return

    const container = selectRange.startContainer
    const offset = selectRange.startOffset

    if (container.nodeType !== Node.TEXT_NODE) return

    const text = container.textContent ?? ''
    const matchRegArray = matchAtTriggerInText(text, offset)
    if (!matchRegArray) return

    const start = offset - matchRegArray[0].length
    const end = offset

    const before = text.slice(0, start)
    const after = text.slice(end)

    const parent = container.parentNode
    if (!parent) return

    const beforeNode = before ? textNode(before) : null
    const chip = createMentionChip(option)
    chip.addEventListener('click', this.handleMentionClick)

    const afterNode = textNode(after)

    // Replace original text node with beforeNode, chip, and afterNode
    parent.replaceChild(afterNode, container)
    parent.insertBefore(chip, afterNode)
    if (beforeNode) parent.insertBefore(beforeNode, chip)

    // Place caret at the start of the afterNode
    setCaret(afterNode, 0)

    editableSection.focus()
    this._showMentions = false
  }

  buildSubmissionString() {
    const root = this.editableSection
    let result = ''

    const traverse = (node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        result += node.textContent ?? ''
        return
      }

      if (isMentionElement(node)) {
        const type = node.getAttribute('data-type') ?? 'user'
        const value = node.getAttribute('data-value') ?? ''
        result += `@${type}:${value}`
        return
      }

      node.childNodes.forEach(traverse)
    }

    root.childNodes.forEach(traverse)
    return result.trim()
  }

  handleSubmit = () => {
    const submission = this.buildSubmissionString()
    console.log('Submitting:', submission)
    this.dispatchEvent(
      new CustomEvent('mention-input:submit', {
        detail: { value: submission },
      }),
    )
  }

  render() {
    return html`
    <div class="mention-input-container"> 
      <div
        class="mention-input"
        contenteditable="true"
        data-placeholder=${this.placeholder}
        @input=${this.handleInput}
      ></div>

      ${this._showMentions
        ? html`
            <div class="mentions-dropdown" role="listbox">
              ${this._filteredMentionOptions.map(
                (option, index) => html`
                  <div
                    class="mention-option ${index === this._selectedIndex
                      ? 'selected'
                      : ''}"
                    role="option"
                    @mousedown=${(e) => {
                      e.preventDefault()
                      this.selectMention(option)
                    }}
                  >
                    ${option.type === 'tab' && option.image
                      ? html`<img
                          class="favicon"
                          src=${option.image}
                          alt=${option.value}
                          width="14"
                          height="14"
                        />`
                      : ''}
                    ${option.type === 'user' ? '@' : ''}
                    ${ellipsis(option.value, 70)}
                  </div>
                `,
              )}
            </div>
            
          `
        : null}
        <hr class="mention-hr"/>
        <div class="mention-actions">
           <moz-button
                    iconsrc="chrome://global/skin/icons/arrow-right.svg"

            @click=${this.handleSubmit}
          >
          </moz-button>
          </div>
            </div>
    `
  }

  static styles = css`
    :host {
      position: relative;
      display: block;
    }

    .mention-hr {
      border: solid 0.5px #e0e0e0;
    }

    .mention-actions {
      display: flex;
      justify-content: flex-end;
      padding-top: 8px;
    }

    .mention-input-container {
      border: 1px solid #ccc;
      padding: 12px;
      background-color: #fff;
      border-radius: 12px;
    }

    .mention-input-container:has(.mention-input:focus) {
        border-color: #007acc;
        box-shadow: 0 0 0 2px rgba(0, 122, 204, 0.2);
      }


    .mention-input {
     
      min-height: 20px;
      border-radius: 12px;
      outline: none;
      cursor: text;
      white-space: pre-wrap;
      word-break: break-word;
      font-size: 16px;
      line-height: 1.8;
    }
   
    .mention-input:empty::before {
      content: attr(data-placeholder);
      color: #999;
      pointer-events: none;
    }

    .mentions-dropdown {
      position: absolute;
      top: 100%;
      left: 0;
      right: 0;
      background: #ffffff;
      border-radius: 4px;
      max-height: 200px;
      overflow-y: auto;
      z-index: 1000;
      margin-top: 4px;
    }
    .mention-option {
      padding: 8px 12px;
      cursor: pointer;
      user-select: none;
      display: flex;
      align-items: center;
      gap: 8px;
      color:#323232;
    }
    .mention-option:hover {
      background: #393939;
    }

    .mention-option.selected {
      background: #007acc;
      color: white;
    }
  `
}

customElements.define('mention-input', MentionInput)

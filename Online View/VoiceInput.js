class ExpenseVoiceInput {
  constructor(onResultCallback) {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      console.warn("Speech Recognition API is not supported in this browser.");
      this.supported = false;
      return;
    }
    this.supported = true;
    this.recognition = new SpeechRecognition();
    this.recognition.continuous = false;
    this.recognition.interimResults = false;
    this.recognition.lang = 'en-US';

    this.recognition.onresult = (event) => {
      const transcript = event.results[0][0].transcript;
      const parsed = this.parseVoiceText(transcript);
      if (onResultCallback) onResultCallback(parsed, transcript);
    };
  }

  start() {
    if (this.supported) this.recognition.start();
  }

  parseVoiceText(text) {
    const amountMatch = text.match(/(\d+(?:\.\d{1,2})?)/);
    const amount = amountMatch ? parseFloat(amountMatch[0]) : null;

    let category = "General";
    const lower = text.toLowerCase();
    if (lower.includes("food") || lower.includes("lunch") || lower.includes("dinner") || lower.includes("coffee")) category = "Food & Dining";
    else if (lower.includes("bus") || lower.includes("uber") || lower.includes("fuel") || lower.includes("gas")) category = "Transportation";
    else if (lower.includes("rent") || lower.includes("bill") || lower.includes("electric")) category = "Bills & Utilities";

    return { amount, category, rawText: text };
  }
}

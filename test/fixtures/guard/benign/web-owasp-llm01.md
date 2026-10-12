# LLM01: Prompt Injection

## Description

A prompt injection vulnerability occurs when user prompts alter the LLM's behavior or output in unintended ways. These inputs can affect the model even if they are imperceptible to humans; a prompt injection does not need to be human-visible or readable, as long as the content is parsed by the model.

### Types of prompt injection

**Direct prompt injections** occur when a user's prompt input directly alters the behavior of the model in unintended or unexpected ways. The input can be either intentional (a malicious actor deliberately crafting a prompt to exploit the model) or unintentional.

**Indirect prompt injections** occur when an LLM accepts input from external sources, such as websites or files. The content may have data that when interpreted by the model alters its behavior.

## Prevention and mitigation strategies

1. Constrain model behavior with specific instructions about the model's role, capabilities and limitations within the system prompt.
2. Define and validate expected output formats.
3. Implement input and output filtering, including semantic filters and string checks for non-allowed content.
4. Enforce privilege control and least privilege access.
5. Require human approval for high-risk actions.
6. Segregate and identify external content.
7. Conduct adversarial testing and attack simulations.

## Example attack scenarios

- Scenario #1: An attacker injects a prompt into a customer support chatbot, instructing it to ignore previous guidelines, query private data stores and send emails, leading to unauthorized access and privilege escalation.
- Scenario #2: A user employs an LLM to summarize a webpage containing hidden instructions that cause the LLM to insert an image linking to a URL, leading to exfiltration of the private conversation.
- Scenario #3: An attacker uploads a resume with split malicious prompts. When an LLM is used to evaluate the candidate, the combined prompts manipulate the model's response, resulting in a positive recommendation despite the actual resume contents.
- Scenario #4: An attacker uses a multilingual or obfuscated (base64, emoji) payload to evade filters.

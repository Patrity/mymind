# Chat templates

Chat models are trained on conversations formatted with special tokens. The chat template turns a list of messages into the exact string the model saw during training.

## ChatML

Many models use the ChatML format. A conversation with a system message and one user turn renders like this:

```
<|im_start|>system
You are a helpful assistant.<|im_end|>
<|im_start|>user
Hello, how are you?<|im_end|>
<|im_start|>assistant
```

The trailing `<|im_start|>assistant` is the generation prompt: it tells the model it's its turn to speak.

## Llama 2

Llama 2 chat models use a different format with `[INST]` and `<<SYS>>` markers:

```
<s>[INST] <<SYS>>
You are a helpful assistant.
<</SYS>>

Hello, how are you? [/INST]
```

## Applying a template

Use `apply_chat_template(messages, add_generation_prompt=True)` instead of building these strings by hand. Getting a single newline wrong can noticeably degrade output quality, and different model families are not interchangeable.

## Writing your own

Templates are Jinja. Loop over `messages`, emit the role header, the content and the end token. Test the rendered string against the reference format from the model card before training or serving.

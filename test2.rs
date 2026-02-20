mod foo {
    macro_rules! bar { () => {} }
}
fn main() {
    foo::bar!();
}

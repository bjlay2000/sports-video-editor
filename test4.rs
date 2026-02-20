mod foo {
    #[macro_export]
    macro_rules! bar { () => {} }
}
use crate::bar;
fn main() {
    bar!();
}
